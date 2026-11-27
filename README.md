# Tools

Fast, privacy-first file tools. Static Astro site (Netlify) plus one small Cloud Run service used only by background removal.

| Category | Tool | Runs |
| --- | --- | --- |
| Images | Remove background | Cloud (EU) |
| Images | Editor (aspect ratio × pixel size, crop with overflow preview, compress, convert, optional EXIF keep), Convert & compress, Resize | Browser |
| PDF | Merge, Split, Reorder/rotate/delete, Images to PDF, Optimize, lossy and black & white export | Browser |
| Audio | Convert & trim: waveform, keep/remove selection, fades → MP3/WAV/OGG | Browser |
| Audio | Export to M4A (AAC)/FLAC/Opus/MP3 with tags and cover art (ffmpeg) | Cloud (EU), optional |
| Files | Explorer for files and folders, bulk rename, ZIP/7z/gzip create and extract | Browser |
| Text | Editor with tabs and split view, JSON format/minify, JavaScript minify, compare, Markdown preview | Browser |
| GPX | Merge, trim, cut, split, clean up (pauses, spikes, privacy zones, simplify) and edit tracks point by point; keeps watch data (heart rate, cadence) | Browser |

The home page opens each app full screen from its badge or card; inside an app, its name in the toolbar switches to another app, and Outputs and Settings sit at the top right. Further down, the start screen lists every tool in one card per app. Files created in any app are collected in the shared Outputs panel (memory only, until the page is left).

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
7. **Editor upscaling.** Pixel-size presets are applied exactly, so small images are enlarged; the editor warns when that happens.

## Known limitations

- Heavy work (PDF edits, Terser, audio encoding) runs on the main thread in chunks, not in workers; very large inputs can briefly freeze the page.
- Local audio export does not copy tags or cover art (use the cloud export for that). MP3 output uses the nearest encoder-supported sample rate (8–48 kHz).
- “Remove selection” joins the parts without a crossfade; preview playback doesn't apply fades.
- The 24-megapixel background-removal limit is enforced server-side only.
