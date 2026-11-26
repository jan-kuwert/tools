# Backend: background removal

FastAPI service behind the cloud tool `images/remove-background`. One request at a time per instance; the
`isnet-general-use` model (Apache-2.0) stays loaded in a long-lived worker process and is baked into the image.

`POST /v1/remove-background` takes the raw image as the body (`Content-Type: image/jpeg|png|webp`, max 20 MiB,
max 24 megapixels) and returns a PNG. Errors: 413 too large, 415 not an image, 422 unreadable or too many pixels,
429 busy (`Retry-After`), 504 over 90 s. `GET /healthz` for health checks. Bodies and filenames are never logged.

## Run locally

```sh
cd backend
uv sync
ALLOWED_ORIGINS=http://localhost:4321 uv run uvicorn app.main:app --port 8080 --workers 1
uv run pytest
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
