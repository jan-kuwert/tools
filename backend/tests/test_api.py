import asyncio
import os
import time
from io import BytesIO
from multiprocessing.connection import Connection

os.environ["ALLOWED_ORIGINS"] = "https://allowed.example"

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app import main
from app.worker import OK, Worker

URL = "/v1/remove-background"


def png(width: int = 4, height: int = 4) -> bytes:
    buf = BytesIO()
    Image.new("RGB", (width, height), "red").save(buf, "PNG")
    return buf.getvalue()


@pytest.fixture
def client(monkeypatch):
    async def fake_run(data, timeout):
        return OK + png(1, 1)

    monkeypatch.setattr(main.worker, "run", fake_run)
    return TestClient(main.app)  # no lifespan: the real worker is never started


def test_success(client):
    r = client.post(URL, content=png(), headers={"Content-Type": "image/png", "Origin": "https://allowed.example"})
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/png"
    assert r.headers["cache-control"] == "no-store"
    assert r.headers["access-control-allow-origin"] == "https://allowed.example"
    assert r.content.startswith(b"\x89PNG")


def test_rejects_non_image(client):
    r = client.post(URL, content=b"%PDF-1.7 not an image", headers={"Content-Type": "image/png"})
    assert r.status_code == 415


def test_rejects_wrong_content_type(client):
    r = client.post(URL, files={"file": ("a.png", png(), "image/png")})  # multipart
    assert r.status_code == 415


def test_rejects_oversized(client):
    body = png() + b"\0" * (20 * 1024 * 1024)
    assert client.post(URL, content=body, headers={"Content-Type": "image/png"}).status_code == 413

    def chunks():  # no Content-Length: the limit must hold while streaming
        yield png()
        for _ in range(21):
            yield b"\0" * (1024 * 1024)

    assert client.post(URL, content=chunks(), headers={"Content-Type": "image/png"}).status_code == 413


def test_rejects_too_many_pixels(client):
    body = png(6000, 4001)  # 24_006_000 px; compresses to a few KB
    assert client.post(URL, content=body, headers={"Content-Type": "image/png"}).status_code == 422


def test_rejects_truncated_image(client):
    assert client.post(URL, content=png()[:20], headers={"Content-Type": "image/png"}).status_code == 422


def test_busy(client):
    asyncio.run(main.lock.acquire())
    try:
        r = client.post(URL, content=png(), headers={"Content-Type": "image/png"})
    finally:
        main.lock.release()
    assert r.status_code == 429
    assert r.headers["retry-after"]


def test_cors_disallowed_origin(client):
    r = client.post(URL, content=png(), headers={"Content-Type": "image/png", "Origin": "https://evil.example"})
    assert "access-control-allow-origin" not in r.headers
    pre = client.options(URL, headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"})
    assert "access-control-allow-origin" not in pre.headers


def test_cors_preflight_allowed(client):
    r = client.options(
        URL,
        headers={"Origin": "https://allowed.example", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type"},
    )
    assert r.status_code == 200
    assert r.headers["access-control-allow-origin"] == "https://allowed.example"
    assert "access-control-allow-credentials" not in r.headers


def test_healthz(client):
    assert client.get("/healthz").json() == {"ok": True}


def echo(conn: Connection) -> None:
    while True:
        data = conn.recv_bytes()
        if data == b"hang":
            time.sleep(60)
        conn.send_bytes(OK + data)


def test_worker_respawns_after_timeout():
    w = Worker(target=echo)
    w.start()
    try:
        assert asyncio.run(w.run(b"hi", 10)) == OK + b"hi"
        first = w._proc
        with pytest.raises(TimeoutError):
            asyncio.run(w.run(b"hang", 0.5))
        assert not first.is_alive() and w._proc is not first
        assert asyncio.run(w.run(b"again", 10)) == OK + b"again"
    finally:
        w.stop()
