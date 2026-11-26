import asyncio
import logging
import os
import time
import warnings
from contextlib import asynccontextmanager, suppress
from io import BytesIO

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image
from starlette.requests import ClientDisconnect

from . import audio
from .worker import BAD_IMAGE, OK, Worker

MAX_BYTES = 20 * 1024 * 1024
MAX_PIXELS = 24_000_000
DEADLINE_S = 90
RETRY_AFTER_S = 10
ALLOWED_TYPES = {"image/jpeg", "image/png", "image/webp"}

Image.MAX_IMAGE_PIXELS = MAX_PIXELS
# Oversized images are rejected explicitly below; the warning would only add log noise.
warnings.simplefilter("ignore", Image.DecompressionBombWarning)

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
log = logging.getLogger("app")

worker = Worker()
lock = asyncio.Lock()


@asynccontextmanager
async def lifespan(_: FastAPI):
    worker.start()  # load the model while the instance starts
    yield
    worker.stop()


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "").split(",") if o.strip()],
    allow_methods=["POST"],
    allow_headers=["Content-Type"],
    allow_credentials=False,
    max_age=600,
)


def sniff(data: bytes | bytearray) -> str | None:
    if data[:3] == b"\xff\xd8\xff":
        return "JPEG"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "PNG"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "WEBP"
    return None


async def read_body(request: Request, limit: int, too_large: str) -> bytearray:
    declared = request.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > limit:
        raise HTTPException(413, too_large)
    body = bytearray()
    async for chunk in request.stream():
        body += chunk
        if len(body) > limit:
            raise HTTPException(413, too_large)
    return body


def check_image(body: bytearray) -> None:
    fmt = sniff(body)
    if fmt is None:
        raise HTTPException(415, "Only JPEG, PNG and WebP images are supported.")
    try:
        # Lazy open: reads the header only.
        with Image.open(BytesIO(body), formats=[fmt]) as img:
            width, height = img.size
    except Image.DecompressionBombError:
        raise HTTPException(422, "Image has more than 24 megapixels.") from None
    except Exception:
        raise HTTPException(422, "Image could not be read.") from None
    if width * height > MAX_PIXELS:
        raise HTTPException(422, "Image has more than 24 megapixels.")


async def wait_disconnect(request: Request) -> None:
    while (await request.receive())["type"] != "http.disconnect":
        pass


async def unless_disconnected(request: Request, coro):
    """Awaits coro; cancels it and raises ClientDisconnect if the client goes away first."""
    job = asyncio.create_task(coro)
    gone = asyncio.create_task(wait_disconnect(request))
    await asyncio.wait({job, gone}, return_when=asyncio.FIRST_COMPLETED)
    if not job.done():
        job.cancel()
        with suppress(asyncio.CancelledError):
            await job
        raise ClientDisconnect
    gone.cancel()
    return job.result()


async def process(request: Request) -> Response:
    if request.headers.get("content-type", "").split(";")[0].strip().lower() not in ALLOWED_TYPES:
        raise HTTPException(415, "Send the image as the raw body with an image/jpeg, image/png or image/webp Content-Type.")
    body = await read_body(request, MAX_BYTES, "Image larger than 20 MiB.")
    check_image(body)

    try:
        reply = await unless_disconnected(request, worker.run(body, DEADLINE_S))  # cancel kills and respawns the worker
    except TimeoutError:
        raise HTTPException(504, "Processing took too long.") from None
    except (EOFError, OSError):
        log.error("worker died")
        raise HTTPException(500, "Processing failed.") from None
    if reply[:1] == BAD_IMAGE:
        raise HTTPException(422, "Image could not be decoded.")
    if reply[:1] != OK:
        raise HTTPException(500, "Processing failed.")
    return Response(reply[1:], media_type="image/png", headers={"Cache-Control": "no-store"})


async def convert_audio(request: Request) -> Response:
    params = audio.parse(request.query_params)
    body = await read_body(request, audio.MAX_BYTES, "Audio larger than 30 MiB.")
    try:
        data, media_type = await unless_disconnected(request, asyncio.wait_for(audio.convert(body, params), DEADLINE_S))
    except TimeoutError:
        raise HTTPException(504, "Processing took too long.") from None
    return Response(data, media_type=media_type, headers={"Cache-Control": "no-store"})


async def one_at_a_time(request: Request, handler) -> Response:
    """Runs one job per instance (Cloud Run concurrency 1 is the backstop) and logs its outcome."""
    if lock.locked():
        raise HTTPException(429, "Busy.", headers={"Retry-After": str(RETRY_AFTER_S)})
    async with lock:
        start = time.monotonic()
        status = 500
        try:
            response = await handler(request)
            status = response.status_code
            return response
        except HTTPException as e:
            status = e.status_code
            raise
        except ClientDisconnect:
            status = 499
            return Response(status_code=499)  # client closed request; never delivered
        finally:
            # Never log bodies, filenames or client details.
            log.info("path=%s status=%d bytes=%s ms=%d", request.url.path, status,
                     request.headers.get("content-length", "-"), (time.monotonic() - start) * 1000)


@app.post("/v1/remove-background")
async def remove_background(request: Request) -> Response:
    return await one_at_a_time(request, process)


@app.post("/v1/audio/convert")
async def audio_convert(request: Request) -> Response:
    return await one_at_a_time(request, convert_audio)


@app.get("/healthz")
async def healthz() -> dict[str, bool]:
    return {"ok": True}
