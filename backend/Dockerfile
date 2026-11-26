FROM python:3.12-slim

COPY --from=ghcr.io/astral-sh/uv:0.13.8 /uv /usr/local/bin/uv

# OMP_NUM_THREADS matches the Cloud Run --cpu value; onnxruntime otherwise sizes its pools by host cores.
# pymatting (via rembg) needs a writable numba cache dir.
ENV PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    PATH=/app/.venv/bin:$PATH \
    U2NET_HOME=/models \
    NUMBA_CACHE_DIR=/tmp/numba \
    OMP_NUM_THREADS=2 \
    PORT=8080

WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-dev && rm /usr/local/bin/uv

# Bake the model into the image so it is never downloaded at runtime. The numba cache
# created here is root-owned and would be unwritable for the runtime user, so drop it.
RUN python -c "from rembg import new_session; new_session('isnet-general-use')" \
    && chmod -R a+rX /models && rm -rf /tmp/numba

# Static ffmpeg/ffprobe: +215 MB unpacked, vs +420 MB for Debian's ffmpeg package and its shared libraries.
COPY --from=mwader/static-ffmpeg:8.0@sha256:415a41fa3167b890b9703d20bd0f00bf1e9dab8a4b6c27fef1445b2bf5f1ab4a /ffmpeg /ffprobe /usr/local/bin/

COPY app ./app

RUN useradd --system --no-create-home app
USER app

CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port $PORT --workers 1 --no-access-log"]
