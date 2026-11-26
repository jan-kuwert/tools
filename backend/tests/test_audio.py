import asyncio
import json
import math
import os
import shutil
import struct
import subprocess
import tempfile
import wave
from io import BytesIO

os.environ.setdefault("ALLOWED_ORIGINS", "https://allowed.example")

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app import main

URL = "/v1/audio/convert"
RATE = 44100
needs_ffmpeg = pytest.mark.skipif(not (shutil.which("ffmpeg") and shutil.which("ffprobe")), reason="ffmpeg not installed")


def sine_wav(seconds: float = 3.0) -> bytes:
    # One second is 440 whole periods, so it repeats seamlessly.
    second = b"".join(struct.pack("<h", int(8000 * math.sin(2 * math.pi * 440 * i / RATE))) for i in range(RATE))
    frames = int(seconds * RATE)
    buf = BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(second * (frames // RATE) + second[:2 * (frames % RATE)])
    return buf.getvalue()


def ffprobe(data: bytes, tmp_path) -> dict:
    path = tmp_path / "probe"
    path.write_bytes(data)
    out = subprocess.run(["ffprobe", "-v", "error", "-of", "json", "-show_format", "-show_streams", str(path)],
                         check=True, capture_output=True).stdout
    return json.loads(out)


@pytest.fixture
def tagged(tmp_path) -> dict[str, bytes]:
    """m4a and mp3 inputs with a title tag and PNG cover art."""
    (tmp_path / "in.wav").write_bytes(sine_wav())
    Image.new("RGB", (8, 8), "red").save(tmp_path / "cover.png")
    files = {}
    for ext, codec in (("m4a", "aac"), ("mp3", "libmp3lame")):
        out = tmp_path / f"tagged.{ext}"
        subprocess.run(["ffmpeg", "-v", "error", "-i", tmp_path / "in.wav", "-i", tmp_path / "cover.png",
                        "-map", "0", "-map", "1", "-c:a", codec, "-c:v", "copy", "-disposition:v", "attached_pic",
                        "-metadata", "title=Sine Test", out], check=True)
        files[ext] = out.read_bytes()
    return files


@pytest.fixture
def scratch(tmp_path, monkeypatch):
    """Redirects the per-request temp dirs so the tests can assert they are removed."""
    d = tmp_path / "scratch"
    d.mkdir()
    monkeypatch.setattr(tempfile, "tempdir", str(d))
    return d


@pytest.fixture
def client():
    return TestClient(main.app)  # no lifespan: the background-removal worker is never started


def post(client, body: bytes, **params):
    return client.post(URL, params=params, content=body, headers={"Content-Type": "application/octet-stream"})


@pytest.mark.parametrize("params", [
    {"format": "wav"},
    {"format": "mp3", "start": 2, "end": 2},
    {"format": "mp3", "start": 3, "end": 1},
    {"format": "mp3", "start": "nan"},
    {"format": "mp3", "start": -1},
    {"format": "mp3", "bitrate": 500},
    {"format": "mp3", "bitrate": "128.5"},
    {"format": "flac", "bitrate": 128},
])
def test_rejects_bad_params(client, params):
    r = post(client, b"irrelevant", **params)
    assert r.status_code == 422
    assert isinstance(r.json()["detail"], str)


def test_rejects_oversized(client):
    body = b"\0" * (30 * 1024 * 1024 + 1)
    assert post(client, body, format="mp3").status_code == 413

    def chunks():  # no Content-Length: the limit must hold while streaming
        for _ in range(31):
            yield b"\0" * (1024 * 1024)

    r = client.post(URL, params={"format": "mp3"}, content=chunks(), headers={"Content-Type": "application/octet-stream"})
    assert r.status_code == 413


def test_busy(client):
    asyncio.run(main.lock.acquire())
    try:
        r = post(client, sine_wav(0.1), format="mp3")
    finally:
        main.lock.release()
    assert r.status_code == 429
    assert r.headers["retry-after"]


def test_cors_preflight(client):
    r = client.options(URL, headers={"Origin": "https://allowed.example", "Access-Control-Request-Method": "POST",
                                     "Access-Control-Request-Headers": "content-type"})
    assert r.status_code == 200
    assert r.headers["access-control-allow-origin"] == "https://allowed.example"


@needs_ffmpeg
@pytest.mark.parametrize("fmt,codec,media_type", [
    ("m4a", "aac", "audio/mp4"),
    ("flac", "flac", "audio/flac"),
    ("opus", "opus", "audio/ogg"),
    ("mp3", "mp3", "audio/mpeg"),
])
def test_converts_trimmed(client, scratch, tmp_path, fmt, codec, media_type):
    r = post(client, sine_wav(), format=fmt, start=0.5, end=2.0, fade_in=0.2, fade_out=0.3)
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == media_type
    assert r.headers["cache-control"] == "no-store"
    info = ffprobe(r.content, tmp_path)
    stream = info["streams"][0]
    assert stream["codec_name"] == codec
    assert abs(float(info["format"]["duration"]) - 1.5) <= 0.05
    assert int(stream["sample_rate"]) == (48000 if fmt == "opus" else RATE)
    if fmt == "flac":
        assert stream["duration_ts"] == int(1.5 * RATE)  # sample-exact
    assert list(scratch.iterdir()) == []


@needs_ffmpeg
@pytest.mark.parametrize("src", ["m4a", "mp3"])
@pytest.mark.parametrize("fmt", ["m4a", "flac", "opus", "mp3"])
def test_keeps_tags_and_cover(client, tagged, tmp_path, src, fmt):
    params = {} if fmt == "flac" else {"bitrate": 128}
    r = post(client, tagged[src], format=fmt, start=1, **params)
    assert r.status_code == 200, r.text
    info = ffprobe(r.content, tmp_path)
    tags = {k.lower(): v for k, v in info["format"].get("tags", {}).items()}
    for s in info["streams"]:
        tags |= {k.lower(): v for k, v in s.get("tags", {}).items()}  # Ogg keeps comments on the stream
    assert tags.get("title") == "Sine Test"
    covers = [s for s in info["streams"] if s["codec_type"] == "video" and s["disposition"]["attached_pic"]]
    assert len(covers) == (0 if fmt == "opus" else 1)
    assert abs(float(info["format"]["duration"]) - 2.0) <= 0.1  # lossy source: encoder delay handling varies


@needs_ffmpeg
def test_rejects_garbage(client, scratch):
    r = post(client, b"%PDF-1.7 definitely not audio" * 100, format="mp3")
    assert r.status_code == 415
    assert list(scratch.iterdir()) == []


@needs_ffmpeg
def test_rejects_end_beyond_duration(client, scratch):
    assert post(client, sine_wav(1.0), format="mp3", end=1.1).status_code == 200  # within tolerance: clamped
    r = post(client, sine_wav(1.0), format="mp3", start=0.5, end=2.0)
    assert r.status_code == 422
    assert post(client, sine_wav(1.0), format="mp3", fade_in=0.6, fade_out=0.6).status_code == 422
    assert list(scratch.iterdir()) == []


@needs_ffmpeg
def test_timeout_kills_ffmpeg_and_cleans_up(client, scratch, monkeypatch):
    monkeypatch.setattr(main, "DEADLINE_S", 0.25)
    assert post(client, sine_wav(300), format="opus").status_code == 504  # encoding takes ~1 s
    assert list(scratch.iterdir()) == []
    if os.path.isdir("/proc"):
        comms = [open(f"/proc/{p}/comm").read().strip() for p in os.listdir("/proc") if p.isdigit()]
        assert "ffmpeg" not in comms
