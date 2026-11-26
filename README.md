# Tools

Fast, privacy-first file tools. Static Astro site (Netlify) plus one small Cloud Run service used only by background removal.

| Category | Tool | Runs |
| --- | --- | --- |
| Images | Remove background | Cloud (EU) |
| Images | Convert & compress, Resize | Browser |
| PDF | Merge, Split, Reorder/rotate/delete, Images to PDF, Optimize | Browser |
| Audio | Convert (M4A/MP3/WAV/OGG/FLAC → MP3/WAV/OGG) | Browser |
| Files | Create ZIP, Gzip/gunzip | Browser |
| Text | JSON format/minify, JavaScript minify | Browser |

## Develop

```sh
npm install
cp .env.example .env   # PUBLIC_API_URL for the cloud tool
npm run dev            # http://localhost:4321/tools/
npm run build          # static output in dist/
```

Backend: see [backend/README.md](backend/README.md).

## Configuration

| Variable | Where | Purpose |
| --- | --- | --- |
| `SITE` | build | Production origin for canonical URLs, e.g. `https://tools.example.com` |
| `BASE` | build | Path prefix, default `/tools` |
| `PUBLIC_API_URL` | build | Cloud Run origin. Unset → cloud tool is disabled with a notice |
| `ALLOWED_ORIGINS` | Cloud Run | Exact frontend origin(s) for CORS |

`netlify.toml` sets a strict CSP. Narrow `connect-src` from `https://*.run.app` to the exact Cloud Run origin when it is known.

## Principles

- Local tools never upload. Heavy libraries load only on the page that uses them.
- Cloud tools ask before every upload; consent is never remembered.
- Only preferences (theme, image defaults) are stored, in `localStorage` key `tools:prefs`.
- Inputs are validated by content (magic bytes), not by extension.

## Open decisions

1. **Domain and base path.** Is the existing domain hosted on Netlify? If not, serving `/tools/` needs a proxy on the main host; a dedicated subdomain avoids that. Set `SITE`/`BASE` accordingly.
2. **Product name.** Header shows the placeholder “Tools”; shortlist in the plan: Pocketmill, Filebench, Byte Orchard.
3. **Background-removal model.** Default `isnet-general-use` (Apache-2.0). Validate quality/speed/memory on Cloud Run before launch.
4. **Public endpoint protection.** Pilot uses the direct Cloud Run URL with max 2 instances and concurrency 1. Decide whether to add Load Balancer + Cloud Armor before public launch.
5. **Split → “Extract into one PDF”.** Pages currently follow the typed order and keep duplicates (`5, 1-2`). Alternative: sort and de-duplicate.
6. **JS minify output target.** Terser default (ES5-compatible output). Targeting modern JS gives smaller output.

## Known limitations

- Heavy work (PDF edits, Terser, audio encoding) runs on the main thread in chunks, not in workers; very large inputs can briefly freeze the page.
- Audio output is always 44.1 kHz; tags and cover art are not copied.
- The 24-megapixel background-removal limit is enforced server-side only.
