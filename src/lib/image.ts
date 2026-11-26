// Shared canvas pipeline for the local image tools: decode → draw → encode.
import { zipSync, type Zippable } from 'fflate';
import { hasGps, readExif, withExif } from './metadata';
import { sniff, UserError, type Result } from './tool';

export type ImageType = 'image/jpeg' | 'image/png' | 'image/webp';

/** iOS Safari refuses canvases above 4096×4096 pixels of area. */
export const MAX_PIXELS = 4096 * 4096;

export const EXT: Record<ImageType, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

const tooLarge = (what: string, w: number, h: number) =>
  new UserError(`${what} is ${w} × ${h} px (${(w * h / 1e6).toFixed(1)} MP). The limit is 16.7 megapixels so it works on every device, including iPhone and iPad.`);

/** Dimensions from the file header, so oversized images are rejected before decoding. */
async function headerSize(file: Blob, kind: string): Promise<[number, number] | undefined> {
  const b = new Uint8Array(await file.slice(0, kind === 'jpeg' ? 512 * 1024 : 32).arrayBuffer());
  const v = new DataView(b.buffer);
  if (b.length < 30) return;
  if (kind === 'png') return [v.getUint32(16), v.getUint32(20)];
  if (kind === 'webp') {
    const chunk = String.fromCharCode(...b.subarray(12, 16));
    if (chunk === 'VP8 ') return [v.getUint16(26, true) & 0x3fff, v.getUint16(28, true) & 0x3fff];
    if (chunk === 'VP8L') return [1 + (((b[22] & 0x3f) << 8) | b[21]), 1 + (((b[24] & 0xf) << 10) | (b[23] << 2) | (b[22] >> 6))];
    if (chunk === 'VP8X') return [1 + (b[24] | (b[25] << 8) | (b[26] << 16)), 1 + (b[27] | (b[28] << 8) | (b[29] << 16))];
    return;
  }
  // JPEG: walk segments to the first SOFn (C0–CF except DHT C4, JPG C8, DAC CC).
  for (let i = 2; i + 9 < b.length && b[i] === 0xff; ) {
    const m = b[i + 1];
    if (m === 0xff) { i++; continue; }
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return [v.getUint16(i + 7), v.getUint16(i + 5)];
    i += 2 + v.getUint16(i + 2);
  }
}

/** Decode a JPEG/PNG/WebP with EXIF orientation applied. Caller must `close()` the bitmap. */
export async function decodeImage(file: File): Promise<{ bitmap: ImageBitmap; type: ImageType }> {
  const kind = await sniff(file);
  if (kind !== 'jpeg' && kind !== 'png' && kind !== 'webp') throw new UserError(`${file.name} is not a JPEG, PNG or WebP image.`);
  const size = await headerSize(file, kind);
  if (size && size[0] * size[1] > MAX_PIXELS) throw tooLarge(file.name, ...size);
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new UserError(`${file.name} could not be read. The file may be damaged.`);
  }
  if (bitmap.width * bitmap.height > MAX_PIXELS) {
    bitmap.close();
    throw tooLarge(file.name, bitmap.width, bitmap.height);
  }
  return { bitmap, type: `image/${kind}` as ImageType };
}

export const canvasOf = (w: number, h: number) => Object.assign(document.createElement('canvas'), { width: w, height: h });

export interface Rect { x: number; y: number; w: number; h: number }

/**
 * Draw `crop` of `source` (default: all of it) at w×h, halving in steps when shrinking a lot
 * to avoid aliasing. `background` fills transparency. `source` itself is never modified.
 */
export function drawImage(source: ImageBitmap | HTMLCanvasElement, w: number, h: number, background?: string, crop?: Rect): HTMLCanvasElement {
  if (w * h > MAX_PIXELS) throw tooLarge('The result', w, h);
  let src: ImageBitmap | HTMLCanvasElement = source;
  let { x, y, w: sw, h: sh } = crop ?? { x: 0, y: 0, w: source.width, h: source.height };
  const free = () => { if (src !== source && src instanceof HTMLCanvasElement) src.width = 0; }; // free memory early (Safari)
  while (sw / 2 >= w && sh / 2 >= h) {
    const step = canvasOf(Math.floor(sw / 2), Math.floor(sh / 2));
    const ctx = step.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, x, y, sw, sh, 0, 0, step.width, step.height);
    free();
    src = step;
    x = y = 0;
    sw = step.width;
    sh = step.height;
  }
  const out = canvasOf(w, h);
  const ctx = out.getContext('2d')!;
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, w, h);
  }
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, x, y, sw, sh, 0, 0, w, h);
  free();
  return out;
}

/** Encode and release the canvas. Browsers silently fall back to PNG for unsupported types, so check. */
export async function encodeCanvas(canvas: HTMLCanvasElement, type: ImageType, quality?: number): Promise<Blob> {
  const { promise, resolve } = Promise.withResolvers<Blob | null>();
  canvas.toBlob(resolve, type, quality);
  const blob = await promise;
  canvas.width = 0;
  if (!blob) throw new UserError('Your browser could not create the image, probably because it ran out of memory. Try a smaller image.');
  if (blob.type !== type) {
    const name = EXT[type].toUpperCase();
    throw new UserError(`Your browser cannot save ${name} images${type === 'image/webp' ? ' (Safari does not support it)' : ''}. Choose PNG or JPEG instead, or use Chrome, Edge or Firefox.`);
  }
  return blob;
}

/** Whether any pixel is not fully opaque. JPEG, and PNG/WebP whose header rules out alpha, skip the pixel scan. */
async function hasAlpha(file: File, preview?: HTMLCanvasElement): Promise<boolean> {
  const kind = await sniff(file);
  const b = new Uint8Array(await file.slice(0, 1 << 16).arrayBuffer());
  const v = new DataView(b.buffer);
  const ascii = (at: number) => String.fromCharCode(...b.subarray(at, at + 4));
  if (kind === 'png') {
    // Colour types 4 and 6 have an alpha channel; the others are transparent only with a tRNS chunk.
    if (b[25] !== 4 && b[25] !== 6)
      for (let i = 8; i + 8 <= b.length && ascii(i + 4) !== 'tRNS'; i += 12 + v.getUint32(i)) if (ascii(i + 4) === 'IDAT') return false;
  } else if (kind === 'webp') {
    if (ascii(12) === 'VP8 ' || (ascii(12) === 'VP8X' && !(b[20] & 0x10))) return false;
  } else return false;

  let canvas = preview;
  if (!canvas) {
    const size = await headerSize(file, kind);
    if (!size || size[0] * size[1] > MAX_PIXELS) return false;
    const k = Math.min(1, 1024 / Math.max(...size));
    const [w, h] = size.map((n) => Math.max(1, Math.round(n * k)));
    const bitmap = await createImageBitmap(file, { resizeWidth: w, resizeHeight: h, resizeQuality: 'medium' });
    canvas = canvasOf(w, h);
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
    bitmap.close();
  }
  const { data } = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
  if (!preview) canvas.width = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 255) return true;
  return false;
}

export interface ImageInfo { alpha: boolean; gps: boolean }
const infos = new WeakMap<File, Promise<ImageInfo>>();

/** Transparency and GPS data of an image, cached per file; never rejects. `preview`: an already decoded copy to scan. */
export function inspectImage(file: File, preview?: HTMLCanvasElement): Promise<ImageInfo> {
  let info = infos.get(file);
  if (!info) {
    info = Promise.all([
      hasAlpha(file, preview).catch(() => false),
      readExif(file).then((e) => !!e && hasGps(e)).catch(() => false),
    ]).then(([alpha, gps]) => ({ alpha, gps }));
    infos.set(file, info);
  }
  return info;
}

/** Copy the EXIF of `from` into `to`. On failure `to` is returned unchanged with a note. */
export async function keepMetadata(from: File, to: Blob): Promise<{ blob: Blob; note?: string }> {
  try {
    const exif = await readExif(from);
    return { blob: exif ? await withExif(to, exif) : to };
  } catch {
    return { blob: to, note: 'Metadata could not be kept.' };
  }
}

/** Keep a quality slider and its number box in step; the slider clamps and rounds. Set `num` yourself after changing `range` from code. */
export function linkQuality(range: HTMLInputElement, num: HTMLInputElement): void {
  num.value = range.value;
  range.addEventListener('input', () => (num.value = range.value));
  num.addEventListener('input', () => {
    if (num.value) range.value = num.value;
  });
  num.addEventListener('change', () => (num.value = range.value));
}

/** Make names unique so outputs (and ZIP entries) don't overwrite each other. */
export function uniqueName(name: string, taken: Set<string>): string {
  let out = name;
  for (let n = 2; taken.has(out); n++) out = name.replace(/(\.[^.]*)?$/, ` (${n})$1`);
  taken.add(out);
  return out;
}

/** Append a stored (level 0) ZIP of all results; images are already compressed. */
export async function withZip(results: Result[], name: string): Promise<Result[]> {
  if (results.length < 2) return results;
  const entries: Zippable = {};
  for (const r of results) entries[r.name] = new Uint8Array(await r.blob.arrayBuffer());
  const zip = zipSync(entries, { level: 0 });
  return [...results, { name, blob: new Blob([zip as BlobPart], { type: 'application/zip' }), note: `All ${results.length} images in one file.` }];
}
