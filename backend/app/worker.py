"""Long-lived background-removal process that keeps the model loaded between requests."""

import asyncio
import multiprocessing as mp
from collections.abc import Callable
from io import BytesIO
from multiprocessing.connection import Connection

from PIL import Image, ImageOps

MODEL = "isnet-general-use"
# First reply byte: outcome of the request.
OK, BAD_IMAGE, FAILED = b"\x00", b"\x01", b"\x02"

# Spawn, not fork: the server process has threads and fork would copy their locks.
_ctx = mp.get_context("spawn")


def serve(conn: Connection) -> None:
    from rembg import new_session, remove  # heavy; only imported in the worker

    session = new_session(MODEL)
    while True:
        try:
            data = conn.recv_bytes()
        except EOFError:
            return
        try:
            img = ImageOps.exif_transpose(Image.open(BytesIO(data))).convert("RGB")
        except Exception:
            conn.send_bytes(BAD_IMAGE)
            continue
        try:
            buf = BytesIO()
            remove(img, session=session).save(buf, "PNG")
            conn.send_bytes(OK + buf.getvalue())
        except Exception:
            conn.send_bytes(FAILED)


class Worker:
    def __init__(self, target: Callable[[Connection], None] = serve) -> None:
        self._target = target
        self._proc: mp.process.BaseProcess | None = None
        self._conn: Connection | None = None

    def start(self) -> None:
        self._conn, child = _ctx.Pipe()
        self._proc = _ctx.Process(target=self._target, args=(child,), daemon=True)
        self._proc.start()
        child.close()

    def stop(self) -> None:
        if self._proc:
            self._proc.kill()
            self._proc.join()
        # Not closed explicitly: an abandoned reader thread may still hold it, and closing
        # could let a new pipe reuse its fd. The thread sees EOF and drops the last reference.
        self._proc = self._conn = None

    async def run(self, data: bytes | bytearray, timeout: float) -> bytes:
        """Send an image, return the raw reply. On timeout, cancellation or a dead worker,
        the process is killed and respawned before the exception propagates."""
        conn = self._conn
        assert conn is not None, "worker not started"

        def call() -> bytes:
            conn.send_bytes(data)
            return conn.recv_bytes()

        try:
            return await asyncio.wait_for(asyncio.to_thread(call), timeout)
        except BaseException:
            self.stop()
            self.start()
            raise
