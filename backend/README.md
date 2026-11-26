# Backend: background removal and audio export

FastAPI service behind the cloud tools `images/remove-background` and the cloud export of `audio/convert`. One
request at a time per instance, shared by both endpoints (a second request gets 429). The `isnet-general-use` model
(Apache-2.0) stays loaded in a long-lived worker process and is baked into the image.

`POST /v1/remove-background` takes the raw image as the body (`Content-Type: image/jpeg|png|webp`, max 20 MiB,
max 24 megapixels) and returns a PNG. Errors: 413 too large, 415 not an image, 422 unreadable or too many pixels,
429 busy (`Retry-After`), 504 over 90 s. `GET /healthz` for health checks. Bodies and filenames are never logged.

`POST /v1/audio/convert?format=m4a|flac|opus|mp3` takes the original audio file as the raw body
(`Content-Type: application/octet-stream`, max 30 MiB, max 60 minutes) and returns it trimmed and re-encoded with
ffmpeg: m4a = AAC (`audio/mp4`, faststart), flac (`audio/flac`), opus = Opus in Ogg at 48 kHz (`audio/ogg`), mp3 =
LAME (`audio/mpeg`). Optional query parameters, all in seconds unless noted:

- `bitrate`: kbps, whole number 64–320, lossy formats only (422 for flac). Defaults: AAC 192, Opus 128, MP3 192.
- `start`, `end`: the kept range `[start, end)`, sample-accurate. `end` up to 0.25 s past the probed duration is
  clamped (browser and ffprobe durations differ by encoder padding); further is 422.
- `fade_in`, `fade_out`: default 0; together they must fit in the range.

Tags are copied; cover art (JPEG/PNG) is kept for m4a, mp3 and flac, dropped for opus. The source sample rate is kept
where the codec allows it. Errors: 413 too large, 415 not decodable audio, 422 invalid parameters or over
60 minutes, 429 busy (`Retry-After`), 504 over 90 s; bodies are JSON `{"detail": "..."}`. Inputs are limited to
common audio demuxers (no playlists or concat lists) and read from a per-request temp dir under `/tmp` (memory on
Cloud Run) that is deleted on every exit path; ffmpeg is killed on timeout or client disconnect.

The image ships static `ffmpeg`/`ffprobe` binaries (mwader/static-ffmpeg 8.0, pinned by digest): +215 MB unpacked,
+104 MB compressed (Debian's `ffmpeg` package would add 420 MB unpacked, 164 MB compressed).

## Run locally

```sh
cd backend
uv sync
ALLOWED_ORIGINS=http://localhost:4321 uv run uvicorn app.main:app --port 8080 --workers 1
uv run pytest  # ffmpeg tests skip unless ffmpeg and ffprobe are on PATH
```

Run the full suite, ffmpeg tests included, against the built image:

```sh
docker build -t tools-backend backend
printf 'FROM tools-backend\nUSER root\nCOPY --from=ghcr.io/astral-sh/uv:0.13.8 /uv /usr/local/bin/uv\nRUN uv sync --locked\nUSER app\n' \
  | docker build -t tools-backend:test -f - backend
docker run --rm -v "$PWD/backend/tests:/app/tests:ro" --entrypoint python tools-backend:test -m pytest -p no:cacheprovider
```

The first local start downloads the model (~180 MB) to `~/.u2net` (or `$U2NET_HOME`). Point the site at it by
copying `.env.example` to `.env` in the repo root (`PUBLIC_API_URL=http://localhost:8080`).

## Deploy (Cloud Run, europe-west1)

```sh
gcloud run deploy tools-backend \
  --source backend \
  --region europe-west1 \
  --cpu 2 --memory 4Gi \
  --concurrency 1 --max-instances 2 --min-instances 0 \
  --timeout 120 --cpu-boost \
  --allow-unauthenticated \
  --set-env-vars ALLOWED_ORIGINS=https://example.com
```

`ALLOWED_ORIGINS` is a comma-separated list of exact origins (scheme + host, no path). Build the site with
`PUBLIC_API_URL` set to the service URL. `OMP_NUM_THREADS` in the Dockerfile matches `--cpu 2`; change both together.
