"""Audio export via ffmpeg: trim, fade and re-encode to formats the browser cannot write."""

import asyncio
import json
import math
import os
import tempfile
from asyncio.subprocess import DEVNULL, PIPE
from contextlib import suppress

from fastapi import HTTPException
from starlette.datastructures import QueryParams

MAX_BYTES = 30 * 1024 * 1024
MAX_DURATION_S = 60 * 60
# The browser's decoded length can exceed ffprobe's by encoder padding; a larger end is clamped.
END_TOLERANCE_S = 0.25

# format: (codec, default kbps or None for lossless, media type, extra output args)
FORMATS = {
    "m4a": ("aac", 192, "audio/mp4", ["-movflags", "+faststart"]),
    "flac": ("flac", None, "audio/flac", []),
    "opus": ("libopus", 128, "audio/ogg", ["-ar", "48000"]),
    "mp3": ("libmp3lame", 192, "audio/mpeg", []),
}
COVER_FORMATS = {"m4a", "mp3", "flac"}
COVER_CODECS = {"mjpeg", "png"}
# Demuxers only: keeps playlist/concat formats (which can open other files or URLs) away from uploads.
INPUT_ARGS = ["-protocol_whitelist", "file",
              "-format_whitelist", "mov,mp4,m4a,mp3,flac,ogg,wav,w64,aiff,matroska,webm,aac,caf,asf,amr,wv,ape"]


def bad(detail: str) -> HTTPException:
    return HTTPException(422, detail)


def number(query: QueryParams, name: str, default: float | None = None) -> float | None:
    raw = query.get(name)
    if raw is None or raw == "":
        return default
    try:
        value = float(raw)
    except ValueError:
        raise bad(f"{name} must be a number.") from None
    if not math.isfinite(value) or value < 0:
        raise bad(f"{name} must be a non-negative number.")
    return value


def parse(query: QueryParams) -> dict:
    """Validates everything that does not need the file; raises 422."""
    fmt = query.get("format", "")
    if fmt not in FORMATS:
        raise bad("format must be one of m4a, flac, opus, mp3.")
    bitrate = number(query, "bitrate")
    if bitrate is not None:
        if FORMATS[fmt][1] is None:
            raise bad("bitrate applies to lossy formats only.")
        if not bitrate.is_integer() or not 64 <= bitrate <= 320:
            raise bad("bitrate must be a whole number of kbps between 64 and 320.")
    p = {"format": fmt, "bitrate": int(bitrate or FORMATS[fmt][1] or 0), "start": number(query, "start", 0.0),
         "end": number(query, "end"), "fade_in": number(query, "fade_in", 0.0), "fade_out": number(query, "fade_out", 0.0)}
    if p["end"] is not None and p["start"] >= p["end"]:
        raise bad("start must be before end.")
    return p


async def run(*args: str) -> bytes:
    """Runs a binary to completion; killed if the caller is cancelled (timeout or disconnect)."""
    proc = await asyncio.create_subprocess_exec(*args, stdin=DEVNULL, stdout=PIPE, stderr=DEVNULL)
    try:
        out, _ = await proc.communicate()
    except BaseException:
        with suppress(ProcessLookupError):
            proc.kill()
        await proc.wait()
        raise
    if proc.returncode:
        raise OSError(proc.returncode)
    return out


async def probe(path: str) -> tuple[float, int | None]:
    """Returns (duration, cover stream index); raises 415 unless the file has a decodable audio stream."""
    try:
        info = json.loads(await run("ffprobe", "-v", "error", *INPUT_ARGS, "-of", "json",
                                    "-show_format", "-show_streams", path))
        streams = info["streams"]
        duration = float(info["format"]["duration"])
    except (OSError, ValueError, KeyError):
        raise HTTPException(415, "File is not decodable audio.") from None
    if not any(s.get("codec_type") == "audio" for s in streams) or not math.isfinite(duration):
        raise HTTPException(415, "File is not decodable audio.")
    cover = next((s["index"] for s in streams if s.get("codec_type") == "video"
                  and s.get("disposition", {}).get("attached_pic") and s.get("codec_name") in COVER_CODECS), None)
    return duration, cover


async def convert(body: bytes | bytearray, p: dict) -> tuple[bytes, str]:
    codec, _, media_type, extra = FORMATS[p["format"]]
    # /tmp is memory-backed on Cloud Run; the directory goes away on every exit path.
    with tempfile.TemporaryDirectory(prefix="audio-", ignore_cleanup_errors=True) as tmp:
        src, dst = os.path.join(tmp, "in"), os.path.join(tmp, "out." + p["format"])
        with open(src, "wb") as f:
            f.write(body)
        duration, cover = await probe(src)
        if duration > MAX_DURATION_S:
            raise bad("Audio is longer than 60 minutes.")
        start, end = p["start"], p["end"]
        if end is None:
            end = duration
        elif end > duration + END_TOLERANCE_S:
            raise bad("end is beyond the end of the audio.")
        end = min(end, duration)
        if start >= end:
            raise bad("start must be before end.")
        length = end - start
        if p["fade_in"] + p["fade_out"] > length:
            raise bad("Fades are longer than the selection.")

        # atrim is sample-accurate; timestamps are rebased to 0 so the fade times are relative to the selection.
        filters = [f"atrim=start={start}:end={end}", "asetpts=PTS-STARTPTS"]
        if p["fade_in"]:
            filters.append(f"afade=t=in:d={p['fade_in']}")
        if p["fade_out"]:
            filters.append(f"afade=t=out:st={length - p['fade_out']}:d={p['fade_out']}")
        args = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", *INPUT_ARGS, "-i", src,
                "-map", "0:a:0", "-map_metadata", "0", "-af", ",".join(filters), "-c:a", codec]
        if p["bitrate"]:
            args += ["-b:a", f"{p['bitrate']}k"]
        if cover is not None and p["format"] in COVER_FORMATS:
            args += ["-map", f"0:{cover}", "-c:v", "copy", "-disposition:v", "attached_pic"]
        try:
            await run(*args, *extra, dst)
        except OSError:
            raise HTTPException(415, "Audio could not be converted.") from None
        with open(dst, "rb") as f:
            return f.read(), media_type
