// Image editor: crop, cut, resize, rotate, mirror and convert on this device, plus optional cloud background removal.
// Markup lives in src/components/ImageEditor.astro.
// The crop rect is in full-resolution pixels of the rotated image ("source px"): inside the image when
// cropping to the frame, around it with "Fit inside". The stage draws a ≤ PREVIEW px copy; export
// decodes the source at full resolution (SVGs are rasterized at the resolution the output needs).
// Crop, Cut and background removal replace an image's pixels and are undoable per image.
import { zipSync, type Zippable } from 'fflate';
import { API_URL, uploadForResult } from './api';
import {
  canvasHasAlpha, canvasOf, decodeImage, drawImage, encodeCanvas, EXT, imageKind, inspectImage, isSvg, keepMetadata, linkQuality, MAX_PIXELS,
  rasterizeSvg, svgSize, uniqueName, type ImageType, type Rect,
} from './image';
import { loadPrefs } from './prefs';
import { resizable } from './resize';
import { confirmUpload, downloadBlob, el, formatBytes, setDial, UserError } from './tool';

export const RATIOS = ['original', 'free', '1:1', '4:5', '3:4', '2:3', '9:16', '16:9', '4:3', '3:2', '21:9', 'custom'] as const;
/** Pixel sizes apply to the long side. */
export const SIZES = ['original', '512', '720', '1080', '1280', '1920', '2048', '2560', '3840', 'custom'] as const;
/** Percent of the crop's own pixels. */
export const SCALES = [25, 50, 75, 100] as const;
export type RatioId = (typeof RATIOS)[number];
export type SizeId = (typeof SIZES)[number];
export const choiceLabel = (id: string) => ({ original: 'Original', free: 'Free', custom: 'Custom' })[id] ?? id;

const PREVIEW = 2048;
const THUMB = 160;
const MIN_ZOOM = 0.1; // "Fit inside": image down to 10 % of the frame
const MIN_CROP = 16; // source px
const HIT = 12; // CSS px around a handle, so a 24 px target
const BG_MAX_BYTES = 20 * 1024 * 1024;
/** Undo steps per image; each may hold a full-resolution bitmap. */
const HISTORY = 10;

type Source = ImageBitmap | HTMLCanvasElement;
type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
type SizeMode = { kind: 'original' } | { kind: 'long'; n: number } | { kind: 'pct'; p: number } | { kind: 'px'; axis: 'w' | 'h'; v: number };

/** One version of an image's pixels. Files decode on demand; Crop and Cut results are held in memory. */
interface Pixels {
  file?: File; // the original, or a background-removal PNG
  bitmap?: ImageBitmap; // baked Crop/Cut result, unrotated
  svg: boolean; // `file` is vector: rasterized at the resolution each export needs
  w: number; // full-resolution size before rotation
  h: number;
  base: HTMLCanvasElement; // ≤ PREVIEW px copy, unrotated
  url: string; // thumbnail
  alpha: boolean; // has transparent pixels
}

interface State {
  px: Pixels;
  rot: number; // quarter turns clockwise, applied before flip
  flip: boolean; // horizontal mirror; a vertical mirror is stored as flip + half turn
  crop: Rect;
}

interface Item extends State {
  origin: File; // as added: name, EXIF and size comparison
  view: HTMLCanvasElement; // px.base with rot/flip applied
  gps: boolean;
  undo: State[];
  redo: State[];
}

let root: HTMLElement | undefined;
let ui: ReturnType<typeof bind>;
let items: Item[] = [];
let cur = 0;
let size: SizeMode = { kind: 'original' };
let full: { px: Pixels; rot: number; flip: boolean; k: number; src: Promise<Source> } | undefined;
let raf = 0;
/** Stage transform of the last draw: canvas px = o + world · vs; `toWorld` is source px per CSS px. */
let stage = { ox: 0, oy: 0, vs: 1, dpr: 1, toWorld: 1 };
let dragging = false;
let estTimer = 0;
let estGen = 0;
let busy = false;
let bgJob: AbortController | undefined;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const freeSource = (s: Source) => (s instanceof ImageBitmap ? s.close() : (s.width = 0));
function freePixels(px: Pixels) {
  if (full?.px === px) dropFull();
  px.base.width = 0;
  px.bitmap?.close();
  URL.revokeObjectURL(px.url);
}
function discard(it: Item) {
  if (it.view !== it.px.base) it.view.width = 0;
  for (const s of [it, ...it.undo, ...it.redo]) freePixels(s.px);
}

function bind(root: HTMLElement) {
  const q = <T extends Element = HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  return {
    form: q<HTMLFormElement>('[data-form]'),
    side: q<HTMLFieldSetElement>('[data-side]'),
    resizer: q('[data-side-resizer]'),
    canvas: q<HTMLCanvasElement>('[data-canvas]'),
    name: q('[data-name]'),
    thumbs: q('[data-thumbs]'),
    crop: q('[data-crop]'),
    needsImage: [...root.querySelectorAll<HTMLButtonElement | HTMLInputElement>('[data-needs-image]')],
    selectionActions: [...root.querySelectorAll<HTMLButtonElement>('[data-crop-apply], [data-cut]')],
    float: q('[data-float]'),
    undo: q<HTMLButtonElement>('[data-undo]'),
    redo: q<HTMLButtonElement>('[data-redo]'),
    removeBg: q<HTMLButtonElement>('[data-remove-bg]'),
    busy: q('[data-busy]'),
    busyText: q('[data-busy-text]'),
    dial: q('[data-dial]'),
    fitSet: q('[data-fit-set]'),
    customRatio: q('[data-custom-ratio]'),
    swap: q<HTMLButtonElement>('[data-swap]'),
    bgSet: q('[data-bg-set]'),
    qualityField: q('[data-quality-field]'),
    qualityNum: q<HTMLInputElement>('[data-quality-num]'),
    jpegWarn: q('[data-jpeg-warn]'),
    gpsHint: q('[data-gps-hint]'),
    svgNote: q('[data-svg-note]'),
    problem: q('[data-problem]'),
    upscaleWarn: q('[data-upscale-warn]'),
    dims: q('[data-dims]'),
    estimate: q('[data-estimate]'),
    download: q<HTMLButtonElement>('[data-download]'),
    downloadAll: q<HTMLButtonElement>('[data-download-all]'),
    status: q('[data-status]'),
  };
}

const field = (name: string) => ui.form.elements.namedItem(name) as HTMLInputElement;
const value = (name: string) => (ui.form.elements.namedItem(name) as RadioNodeList | HTMLInputElement).value;
const radio = (name: string, v: string) => ui.form.querySelector<HTMLInputElement>(`[name=${name}][value="${v}"]`);
const ratioId = () => value('ratio') as RatioId;
/** Crop inside the image; otherwise ("Fit inside") the frame surrounds it. Free always crops. */
const cropMode = () => ratioId() === 'free' || value('fit') === 'fill';
const format = () => value('format') as ImageType;
const quality = () => Number(field('quality').value) / 100;
/** Colour behind transparent pixels and padding; JPEG has no alpha so it always gets one. */
const background = () => (format() === 'image/jpeg' || value('bg') === 'colour' ? field('colour').value : undefined);

const dims = (it: State): [number, number] => (it.rot % 2 ? [it.px.h, it.px.w] : [it.px.w, it.px.h]);

/** Width / height the crop must have: undefined for Free, NaN if the custom ratio is invalid. */
function targetRatio(it: Item): number | undefined {
  const id = ratioId();
  if (id === 'free') return;
  const [W, H] = dims(it);
  if (id === 'original') return W / H;
  const [a, b] = id === 'custom' ? [Number(field('rw').value), Number(field('rh').value)] : id.split(':').map(Number);
  return a > 0 && b > 0 ? a / b : NaN;
}

/** Zoom-1 crop of ratio r: the largest inside the image, or with Fit the smallest around it. */
function baseSize(it: Item, r: number): [number, number] {
  const [W, H] = dims(it);
  return W / H > r === cropMode() ? [H * r, H] : [W, W / r];
}

const minCrop = (it: Item) => Math.min(...dims(it), Math.max(MIN_CROP, HIT * stage.toWorld));
const zoomOf = (it: Item) => baseSize(it, it.crop.w / it.crop.h)[0] / it.crop.w;
function zoomRange(it: Item): [number, number] {
  if (!cropMode()) return [MIN_ZOOM, 1];
  const [bw, bh] = baseSize(it, it.crop.w / it.crop.h);
  return [1, Math.max(1, Math.min(bw, bh) / Math.min(MIN_CROP, ...dims(it)))];
}

/** Enforce the ratio, zoom range and bounds, keeping the crop's centre. */
function clampCrop(it: Item) {
  const [W, H] = dims(it);
  const r = targetRatio(it);
  let { x, y, w, h } = it.crop;
  const cx = x + w / 2;
  const cy = y + h / 2;
  if (r && Number.isFinite(r) && Math.abs(w / h - r) > r * 1e-6) {
    w = Math.sqrt(w * h * r);
    h = w / r;
  }
  const [bw, bh] = baseSize(it, w / h);
  const z = clamp(bw / w, ...zoomRange(it));
  w = bw / z;
  h = bh / z;
  const fill = cropMode();
  x = fill ? clamp(cx - w / 2, 0, W - w) : clamp(cx - w / 2, W - w, 0);
  y = fill ? clamp(cy - h / 2, 0, H - h) : clamp(cy - h / 2, H - h, 0);
  it.crop = { x, y, w, h };
}

/** Largest crop of the selected ratio (whole image for Free), centred. */
function resetCrop(it: Item) {
  const [W, H] = dims(it);
  const r = targetRatio(it);
  const [w, h] = r && Number.isFinite(r) ? baseSize(it, r) : [W, H];
  it.crop = { x: (W - w) / 2, y: (H - h) / 2, w, h };
}

/** Whether the crop is a real selection: Crop and Cut need part of the image left out. */
function hasSelection(it: Item | undefined): it is Item {
  if (!it || !cropMode() || problem(it)) return false;
  const [W, H] = dims(it);
  const c = it.crop;
  return Math.round(c.x) > 0 || Math.round(c.y) > 0 || Math.round(c.x + c.w) < W || Math.round(c.y + c.h) < H;
}

function setZoom(it: Item, z: number) {
  const { x, y, w, h } = it.crop;
  const [bw, bh] = baseSize(it, w / h);
  z = clamp(z, ...zoomRange(it));
  it.crop = { x: x + w / 2 - bw / z / 2, y: y + h / 2 - bh / z / 2, w: bw / z, h: bh / z };
  clampCrop(it);
}

/** Drag a handle by (dx, dy) source px from the crop `c0`. Fixed ratios grow from the opposite corner or edge. */
function resizeCrop(it: Item, hd: Handle, c0: Rect, dx: number, dy: number) {
  const [W, H] = dims(it);
  const m = minCrop(it);
  const [west, east, north, south] = ['w', 'e', 'n', 's'].map((s) => hd.includes(s));
  let [l, t, r, b] = [c0.x, c0.y, c0.x + c0.w, c0.y + c0.h];
  if (west) l = clamp(l + dx, 0, r - m);
  if (east) r = clamp(r + dx, l + m, W);
  if (north) t = clamp(t + dy, 0, b - m);
  if (south) b = clamp(b + dy, t + m, H);
  const ratio = targetRatio(it);
  if (!ratio || !Number.isFinite(ratio)) {
    [l, t, r, b] = [l, t, r, b].map(Math.round);
    it.crop = { x: l, y: t, w: r - l, h: b - t };
    return;
  }
  let w = r - l;
  const h = b - t;
  // Corners follow whichever axis moved more; edges drive their own axis.
  if ((west || east) && (north || south)) w = Math.abs(w - c0.w) >= Math.abs(h * ratio - c0.w) ? w : h * ratio;
  else if (north || south) w = h * ratio;
  const ax = west ? c0.x + c0.w : east ? c0.x : c0.x + c0.w / 2;
  const ay = north ? c0.y + c0.h : south ? c0.y : c0.y + c0.h / 2;
  const roomW = west ? ax : east ? W - ax : 2 * Math.min(ax, W - ax);
  const roomH = north ? ay : south ? H - ay : 2 * Math.min(ay, H - ay);
  w = clamp(w, Math.max(m, m * ratio), Math.min(roomW, roomH * ratio));
  const nh = w / ratio;
  it.crop = { x: west ? ax - w : east ? ax : ax - w / 2, y: north ? ay - nh : south ? ay : ay - nh / 2, w, h: nh };
}

/** Output px per crop px. */
function scaleOf(it: Item): number {
  const { w, h } = it.crop;
  return size.kind === 'original' ? 1 : size.kind === 'pct' ? size.p / 100 : size.kind === 'long' ? size.n / Math.max(w, h) : size.v / (size.axis === 'w' ? w : h);
}

function outSize(it: Item): [number, number] {
  const k = scaleOf(it);
  return [Math.max(1, Math.round(it.crop.w * k)), Math.max(1, Math.round(it.crop.h * k))];
}

/** Raster scale for an SVG source: as sharp as the output needs, within the pixel limit. Raster sources: 1. */
function rasterScale(it: Item): number {
  if (!it.px.svg) return 1;
  const cap = Math.sqrt(MAX_PIXELS / (it.px.w * it.px.h));
  return Math.min(cap, Math.max(1, Math.ceil(scaleOf(it) * 100) / 100));
}

function problem(it: Item): string | undefined {
  if (Number.isNaN(targetRatio(it))) return 'Enter an aspect ratio with both sides above 0.';
  const [w, h] = outSize(it);
  if (w * h > MAX_PIXELS) return `${w} × ${h} px is above the 16.7 megapixel limit that works on every device, including iPhone and iPad.`;
}

/** Rotate/flip losslessly; returns `src` itself when there is nothing to do. */
function orient<T extends Source>(src: T, rot: number, flip: boolean): T | HTMLCanvasElement {
  if (!rot && !flip) return src;
  const c = canvasOf(rot % 2 ? src.height : src.width, rot % 2 ? src.width : src.height);
  const ctx = c.getContext('2d')!;
  ctx.translate(c.width / 2, c.height / 2);
  if (flip) ctx.scale(-1, 1);
  ctx.rotate((rot * Math.PI) / 2);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  return c;
}

const previewOf = (src: Source) => {
  const k = Math.min(1, PREVIEW / Math.max(src.width, src.height));
  return drawImage(src, Math.max(1, Math.round(src.width * k)), Math.max(1, Math.round(src.height * k)));
};

async function filePixels(file: File): Promise<Pixels> {
  if (await isSvg(file)) {
    const [w, h] = await svgSize(file);
    const k = PREVIEW / Math.max(w, h);
    const base = await rasterizeSvg(file, Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k)));
    return { file, svg: true, w, h, base, url: URL.createObjectURL(file), alpha: false };
  }
  const { bitmap } = await decodeImage(file);
  try {
    return { file, svg: false, w: bitmap.width, h: bitmap.height, base: previewOf(bitmap), url: URL.createObjectURL(file), alpha: false };
  } finally {
    bitmap.close();
  }
}

/** Keep a Crop/Cut result in memory. Takes ownership of `canvas`. */
async function bakedPixels(canvas: HTMLCanvasElement): Promise<Pixels> {
  const base = previewOf(canvas);
  const bitmap = await createImageBitmap(canvas);
  const k = Math.min(1, THUMB / Math.max(base.width, base.height));
  const thumb = drawImage(base, Math.max(1, Math.round(base.width * k)), Math.max(1, Math.round(base.height * k)));
  const blob = await encodeCanvas(thumb, 'image/png');
  const px: Pixels = { bitmap, svg: false, w: canvas.width, h: canvas.height, base, url: URL.createObjectURL(blob), alpha: canvasHasAlpha(base) };
  canvas.width = 0;
  return px;
}

/** Fill in `alpha` (and GPS for the original file) once detected. */
function inspect(it: Item, px: Pixels) {
  if (!px.file) return;
  void inspectImage(px.file, px.base).then((info) => {
    px.alpha = info.alpha;
    if (px.file === it.origin) it.gps = info.gps;
    if (items.includes(it)) syncHints();
  });
}

async function load(file: File): Promise<Item> {
  const px = await filePixels(file);
  const it: Item = { px, origin: file, view: px.base, rot: 0, flip: false, crop: { x: 0, y: 0, w: px.w, h: px.h }, gps: false, undo: [], redo: [] };
  resetCrop(it);
  inspect(it, px);
  return it;
}

function dropFull() {
  if (!full) return;
  const { px, src } = full;
  src.then((s) => s !== px.bitmap && freeSource(s), () => {});
  full = undefined;
}

/** Full-resolution, rotated source (SVGs at `k` × their own size). Only one is kept in memory. */
function fullOf(it: Item, k = 1): Promise<Source> {
  const { px, rot, flip } = it;
  if (full && full.px === px && full.rot === rot && full.flip === flip && full.k === k) return full.src;
  dropFull();
  const raw: Promise<Source> = px.bitmap
    ? Promise.resolve(px.bitmap)
    : px.svg
      ? rasterizeSvg(px.file!, Math.max(1, Math.round(px.w * k)), Math.max(1, Math.round(px.h * k)))
      : decodeImage(px.file!).then((r) => r.bitmap);
  const src = raw.then((s) => {
    const out = orient(s, rot, flip);
    if (out !== s && s !== px.bitmap) freeSource(s);
    return out;
  });
  const entry = { px, rot, flip, k, src };
  full = entry;
  src.catch(() => full === entry && (full = undefined));
  return src;
}

function renderOutput(it: Item, src: Source): HTMLCanvasElement {
  const [W, H] = dims(it);
  const [FW, FH] = outSize(it);
  const ks = src.width / W; // > 1 for SVGs rasterized above their own size
  const c = it.crop;
  const sx = FW / c.w;
  const sy = FH / c.h;
  const out = canvasOf(FW, FH);
  const ctx = out.getContext('2d')!;
  const bg = background();
  if (bg) {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, FW, FH);
  }
  // Where the whole image lands in output px; scale only the visible part (high quality, never larger than the frame).
  const x0 = -c.x * sx;
  const y0 = -c.y * sy;
  const dx0 = Math.max(0, Math.round(x0));
  const dy0 = Math.max(0, Math.round(y0));
  const dx1 = Math.min(FW, Math.round(x0 + W * sx));
  const dy1 = Math.min(FH, Math.round(y0 + H * sy));
  if (dx1 > dx0 && dy1 > dy0) {
    const x = clamp((dx0 - x0) / sx, 0, W);
    const y = clamp((dy0 - y0) / sy, 0, H);
    const w = Math.min(W - x, (dx1 - dx0) / sx);
    const h = Math.min(H - y, (dy1 - dy0) / sy);
    const piece = drawImage(src, dx1 - dx0, dy1 - dy0, undefined, { x: x * ks, y: y * ks, w: w * ks, h: h * ks });
    ctx.drawImage(piece, dx0, dy0);
    piece.width = 0;
  }
  return out;
}

async function exportBlob(it: Item): Promise<{ blob: Blob; note?: string }> {
  const p = problem(it);
  if (p) throw new UserError(p);
  const canvas = renderOutput(it, await fullOf(it, rasterScale(it)));
  const type = format();
  const blob = await encodeCanvas(canvas, type, type === 'image/png' ? undefined : quality());
  return field('strip').checked ? { blob } : keepMetadata(it.origin, blob);
}

const baseName = (it: Item) => it.origin.name.replace(/\.[^./]*$/, '') || 'image';
const outName = (it: Item) => {
  const [w, h] = outSize(it);
  return `${baseName(it)}-${w}x${h}.${EXT[format()]}`;
};

// ---- History ----

const snapshot = (it: Item): State => ({ px: it.px, rot: it.rot, flip: it.flip, crop: { ...it.crop } });

/** Show `s` as the item's current state. */
function setState(it: Item, s: State) {
  if (it.view !== it.px.base) it.view.width = 0;
  Object.assign(it, { px: s.px, rot: s.rot, flip: s.flip, crop: { ...s.crop } });
  it.view = orient(it.px.base, it.rot, it.flip);
  clampCrop(it);
  renderThumbs();
  changed();
}

/** Record the current state before replacing the pixels; drops the redo branch and the oldest steps. */
function pushHistory(it: Item) {
  it.undo.push(snapshot(it));
  while (it.undo.length > HISTORY) freePixels(it.undo.shift()!.px);
  for (const s of it.redo.splice(0)) freePixels(s.px);
}

function step(back: boolean) {
  const it = items[cur];
  if (!it || busy) return;
  const s = (back ? it.undo : it.redo).pop();
  if (!s) return;
  (back ? it.redo : it.undo).push(snapshot(it));
  setState(it, s);
  setStatus(back ? 'Undone.' : 'Redone.', 'done');
}

/** Crop: the selection becomes the image. Cut: the selection becomes transparent. Rotation and mirroring are baked in. */
function bake(kind: 'crop' | 'cut') {
  const it = items[cur];
  if (!hasSelection(it)) return;
  return run(async () => {
    setStatus(kind === 'crop' ? 'Cropping…' : 'Cutting…', 'working');
    const wasSvg = it.px.svg;
    const [W] = dims(it);
    const src = await fullOf(it, rasterScale(it));
    const ks = src.width / W;
    const c = it.crop;
    const [x, y] = [Math.round(c.x * ks), Math.round(c.y * ks)];
    const [w, h] = [Math.round((c.x + c.w) * ks) - x, Math.round((c.y + c.h) * ks) - y];
    const canvas = kind === 'crop' ? canvasOf(w, h) : canvasOf(src.width, src.height);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(src, kind === 'crop' ? -x : 0, kind === 'crop' ? -y : 0);
    if (kind === 'cut') ctx.clearRect(x, y, w, h);
    const px = await bakedPixels(canvas);
    pushHistory(it);
    const next: Item = { ...it, px, rot: 0, flip: false };
    resetCrop(next);
    setState(it, next);
    const what = kind === 'crop' ? `Cropped to ${w} × ${h} px.` : `Cut out ${w} × ${h} px; that area is now transparent.`;
    setStatus(`${what}${wasSvg ? ' The SVG was converted to pixels.' : ''}`, 'done');
  });
}

// ---- Stage ----

/** Stage colours from the theme's CSS variables, resolved to values canvas accepts (light-dark() is not). */
let palette = { a: '#34353a', b: '#44454b', dim: 'rgb(14 14 18 / 0.62)' };
function refreshPalette() {
  const probe = ui.canvas;
  const resolve = (v: string) => {
    probe.style.color = `var(${v})`;
    return getComputedStyle(probe).color;
  };
  palette = { a: resolve('--ie-check-a'), b: resolve('--ie-check-b'), dim: resolve('--ie-dim') };
  probe.style.color = '';
  requestDraw();
}

let checker: { key: string; tile: HTMLCanvasElement } | undefined;
function checkerPattern(ctx: CanvasRenderingContext2D, dpr: number) {
  const key = `${dpr} ${palette.a} ${palette.b}`;
  if (checker?.key !== key) {
    const n = Math.round(8 * dpr);
    const tile = canvasOf(2 * n, 2 * n);
    const t = tile.getContext('2d')!;
    t.fillStyle = palette.a;
    t.fillRect(0, 0, 2 * n, 2 * n);
    t.fillStyle = palette.b;
    t.fillRect(0, 0, n, n);
    t.fillRect(n, n, n, n);
    checker = { key, tile };
  }
  return ctx.createPattern(checker.tile, 'repeat')!;
}

/** Handle centres in canvas px for the current crop. */
function handlePoints(): [Handle, number, number][] {
  const c = items[cur].crop;
  const { ox, oy, vs } = stage;
  const [l, t, r, b] = [ox + c.x * vs, oy + c.y * vs, ox + (c.x + c.w) * vs, oy + (c.y + c.h) * vs];
  const [mx, my] = [(l + r) / 2, (t + b) / 2];
  return [['nw', l, t], ['ne', r, t], ['sw', l, b], ['se', r, b], ['n', mx, t], ['s', mx, b], ['w', l, my], ['e', r, my]];
}

/** Floating Crop/Cut bar under the selection, or above it, or inside its bottom edge; hidden while dragging. */
function placeFloat(frame: Rect) {
  const it = items[cur];
  const bar = ui.float;
  bar.hidden = dragging || busy || !hasSelection(it);
  if (bar.hidden) return;
  const { dpr } = stage;
  const [l, t, w, h] = [frame.x / dpr, frame.y / dpr, frame.w / dpr, frame.h / dpr];
  const [bw, bh] = [bar.offsetWidth, bar.offsetHeight];
  const H = ui.canvas.clientHeight;
  const gap = 10;
  const top = t + h + gap + bh <= H ? t + h + gap : t - gap - bh >= 0 ? t - gap - bh : t + h - gap - bh;
  bar.style.left = `${clamp(l + w / 2 - bw / 2, 4, ui.canvas.clientWidth - bw - 4)}px`;
  bar.style.top = `${clamp(top, 4, H - bh - 4)}px`;
}

function draw() {
  raf = 0;
  const it = items[cur];
  const { canvas } = ui;
  const ctx = canvas.getContext('2d');
  ui.float.hidden = true;
  if (!it || !ctx || !canvas.width) return;
  const { width: cw, height: ch } = canvas;
  ctx.clearRect(0, 0, cw, ch);
  if (problem(it)) return;
  const dpr = cw / canvas.clientWidth;
  const [W, H] = dims(it);
  const fill = cropMode();
  const c = it.crop;
  const box = fill ? { x: 0, y: 0, w: W, h: H } : c;
  const pad = 24 * dpr;
  const vs = Math.min((cw - 2 * pad) / box.w, (ch - 2 * pad) / box.h);
  const ox = (cw - box.w * vs) / 2 - box.x * vs;
  const oy = (ch - box.h * vs) / 2 - box.y * vs;
  stage = { ox, oy, vs, dpr, toWorld: dpr / vs };
  const d = (r: Rect): Rect => ({ x: ox + r.x * vs, y: oy + r.y * vs, w: r.w * vs, h: r.h * vs });
  const img = d({ x: 0, y: 0, w: W, h: H });
  const frame = d(c);
  const back = fill ? img : frame;

  ctx.fillStyle = background() ?? checkerPattern(ctx, dpr);
  ctx.fillRect(back.x, back.y, back.w, back.h);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(it.view, img.x, img.y, img.w, img.h);

  if (fill) {
    ctx.beginPath();
    ctx.rect(img.x, img.y, img.w, img.h);
    ctx.rect(frame.x, frame.y, frame.w, frame.h);
    ctx.fillStyle = palette.dim;
    ctx.fill('evenodd');
  }
  ctx.beginPath();
  for (const k of [1 / 3, 2 / 3]) {
    ctx.moveTo(frame.x + frame.w * k, frame.y);
    ctx.lineTo(frame.x + frame.w * k, frame.y + frame.h);
    ctx.moveTo(frame.x, frame.y + frame.h * k);
    ctx.lineTo(frame.x + frame.w, frame.y + frame.h * k);
  }
  ctx.lineWidth = dpr;
  ctx.strokeStyle = 'rgb(255 255 255 / 0.3)';
  ctx.stroke();
  ctx.lineWidth = 3 * dpr;
  ctx.strokeStyle = 'rgb(0 0 0 / 0.45)';
  ctx.strokeRect(frame.x, frame.y, frame.w, frame.h);
  ctx.lineWidth = 1.5 * dpr;
  ctx.strokeStyle = '#fff';
  ctx.strokeRect(frame.x, frame.y, frame.w, frame.h);
  if (!fill) return;
  const s = 9 * dpr;
  for (const [, x, y] of handlePoints()) {
    ctx.fillStyle = '#fff';
    ctx.fillRect(x - s / 2, y - s / 2, s, s);
    ctx.lineWidth = dpr;
    ctx.strokeStyle = 'rgb(0 0 0 / 0.55)';
    ctx.strokeRect(x - s / 2, y - s / 2, s, s);
  }
  placeFloat(frame);
}

const requestDraw = () => (raf ||= requestAnimationFrame(draw));

/** What a pointer at client (x, y) would grab: a crop handle, or the crop/image to move. */
function hitTest(x: number, y: number): Handle | 'move' {
  if (!cropMode()) return 'move';
  const rect = ui.canvas.getBoundingClientRect();
  const px = (x - rect.left) * stage.dpr;
  const py = (y - rect.top) * stage.dpr;
  const reach = HIT * stage.dpr;
  const pts = handlePoints();
  for (const [hd, hx, hy] of pts.slice(0, 4)) if (Math.abs(px - hx) <= reach && Math.abs(py - hy) <= reach) return hd;
  const [[, l, t], , , [, r, b]] = pts;
  if (px > l && px < r) {
    if (Math.abs(py - t) <= reach) return 'n';
    if (Math.abs(py - b) <= reach) return 's';
  }
  if (py > t && py < b) {
    if (Math.abs(px - l) <= reach) return 'w';
    if (Math.abs(px - r) <= reach) return 'e';
  }
  return 'move';
}

const CURSORS: Record<Handle | 'move', string> = { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize', move: 'move' };

/** Move by CSS px on screen: when cropping the frame follows the pointer, with Fit the image does. */
function moveBy(it: Item, from: Rect, dx: number, dy: number) {
  const k = (cropMode() ? 1 : -1) * stage.toWorld;
  it.crop = { ...from, x: from.x + dx * k, y: from.y + dy * k };
  clampCrop(it);
}

function zoomBy(it: Item | undefined, factor: number) {
  if (!it) return;
  setZoom(it, zoomOf(it) * factor);
  changed();
}

// ---- UI sync ----

function readouts() {
  const it = items[cur];
  const has = !!it;
  root!.toggleAttribute('data-empty', !has);
  ui.side.disabled = !has;
  for (const c of ui.needsImage) c.disabled = !has || busy;
  for (const b of ui.selectionActions) b.disabled = busy || !hasSelection(it);
  ui.undo.disabled = busy || !it?.undo.length;
  ui.redo.disabled = busy || !it?.redo.length;
  ui.removeBg.disabled = !has || busy || !API_URL;
  ui.download.disabled = ui.downloadAll.disabled = true;
  ui.name.textContent = !it ? '' : items.length > 1 ? `${it.origin.name} (${cur + 1} of ${items.length})` : it.origin.name;
  ui.svgNote.hidden = !it?.px.svg;
  if (!it) {
    ui.crop.textContent = '';
    ui.dims.textContent = ui.estimate.textContent = '–';
    ui.upscaleWarn.hidden = ui.problem.hidden = true;
    return;
  }
  const err = problem(it);
  const [W, H] = dims(it);
  const [FW, FH] = outSize(it);
  ui.dims.textContent = err ? '–' : `${FW} × ${FH} px`;
  ui.problem.textContent = err ?? '';
  ui.problem.hidden = !err;
  const zoom = field('zoom');
  const [lo, hi] = zoomRange(it);
  zoom.min = String(lo);
  zoom.max = String(Math.min(hi, 8));
  zoom.value = String(zoomOf(it));
  const s = FW / it.crop.w;
  const pct = `${Math.round(s * 100)}%`;
  zoom.setAttribute('aria-valuetext', `${pct} of original pixels`);
  // Enlarging a raster invents pixels (vectors stay sharp); tolerate rounding noise just above 100%.
  const upscaled = !err && !it.px.svg && s > 1.01;
  ui.upscaleWarn.hidden = !upscaled;
  if (upscaled) ui.upscaleWarn.textContent = `Enlarged to ${pct} of the original pixels, so the result may look soft or blurry. Use a larger image, a bigger crop or a smaller output size for a sharp result.`;
  const [x, y, w, h] = [it.crop.x, it.crop.y, it.crop.w, it.crop.h].map(Math.round);
  ui.crop.textContent = err
    ? ''
    : cropMode()
      ? `Crop ${w} × ${h} px from ${x}, ${y} of ${W} × ${H} · scaled to ${pct}`
      : `Image ${W} × ${H} px at ${-x}, ${-y} in a ${w} × ${h} frame · scaled to ${pct}`;
  ui.download.disabled = ui.downloadAll.disabled = busy || !!err;
}

/** Show/hide and refill controls. `editing` is the field being typed in; it is left alone. */
function syncControls(editing?: string) {
  const it = items[cur];
  const jpeg = format() === 'image/jpeg';
  ui.customRatio.hidden = ratioId() !== 'custom';
  ui.fitSet.hidden = ratioId() === 'free';
  ui.bgSet.hidden = jpeg;
  field('colour').disabled = !jpeg && value('bg') !== 'colour';
  ui.qualityField.hidden = format() === 'image/png';
  ui.downloadAll.hidden = items.length < 2;
  for (const r of ui.form.querySelectorAll<HTMLInputElement>('[name=size], [name=scale]'))
    r.checked = r.name === 'size' ? (size.kind === 'original' ? r.value === 'original' : size.kind === 'long' && Number(r.value) === size.n) : size.kind === 'pct' && Number(r.value) === size.p;
  if (it) {
    const [w, h] = outSize(it);
    const vals = { cw: w, ch: h, pct: Math.round(scaleOf(it) * 1000) / 10 };
    for (const [name, v] of Object.entries(vals)) if (name !== editing) field(name).value = String(v);
  }
  syncHints();
  ui.thumbs.querySelectorAll<HTMLButtonElement>('button').forEach((b, i) => {
    b.ariaCurrent = i === cur ? 'true' : null;
    const t = items[i];
    b.querySelector('img')!.style.transform = `${t.flip ? 'scaleX(-1) ' : ''}rotate(${t.rot * 90}deg)`;
  });
  readouts();
}

function syncHints() {
  ui.jpegWarn.hidden = format() !== 'image/jpeg' || !items.some((it) => it.px.alpha);
  ui.gpsHint.hidden = field('strip').checked || !items.some((it) => it.gps);
}

/** Refresh everything after a state change; `editing` is the field being typed in. */
function changed(editing?: string) {
  if (ui.status.dataset.kind === 'done') setStatus('');
  syncControls(editing);
  requestDraw();
  scheduleEstimate();
}

function scheduleEstimate() {
  const it = items[cur];
  clearTimeout(estTimer);
  const gen = ++estGen;
  if (!it || problem(it)) return;
  ui.estimate.textContent = 'calculating…';
  estTimer = window.setTimeout(async () => {
    try {
      const { blob } = await exportBlob(it);
      if (gen !== estGen) return;
      const pct = Math.round((blob.size / it.origin.size - 1) * 100);
      ui.estimate.textContent = `${formatBytes(blob.size)} · ${pct === 0 ? 'same as original' : pct < 0 ? `${-pct}% smaller` : `${pct}% larger`}`;
    } catch (err) {
      if (gen === estGen) ui.estimate.textContent = message(err);
    }
  }, 300);
}

function message(err: unknown) {
  if (err instanceof UserError) return err.message;
  console.error(err);
  return `Something went wrong: ${(err as Error)?.message ?? err}`;
}

function setStatus(text: string, kind: 'idle' | 'working' | 'error' | 'done' = 'idle') {
  ui.status.textContent = text;
  ui.status.dataset.kind = kind;
}

function reorient(it: Item) {
  if (it.view !== it.px.base) it.view.width = 0;
  it.view = orient(it.px.base, it.rot, it.flip);
  clampCrop(it);
  changed();
}

function rotate(d: 1 | -1) {
  const it = items[cur];
  const [W, H] = dims(it);
  const c = it.crop;
  // Rotation is applied before the flip, so a visual turn runs the other way while flipped.
  it.rot = (it.rot + (it.flip ? -d : d) + 4) % 4;
  it.crop = d > 0 ? { x: H - c.y - c.h, y: c.x, w: c.h, h: c.w } : { x: c.y, y: W - c.x - c.w, w: c.h, h: c.w };
  reorient(it);
}

function flip(vertical: boolean) {
  const it = items[cur];
  const [W, H] = dims(it);
  const c = it.crop;
  it.flip = !it.flip;
  // Vertical mirror = horizontal mirror after a half turn.
  if (vertical) it.rot = (it.rot + 2) % 4;
  it.crop = vertical ? { ...c, y: H - c.y - c.h } : { ...c, x: W - c.x - c.w };
  reorient(it);
}

/** Turn the ratio on its side, e.g. 3:2 → 2:3; ratios without a preset become Custom. */
function swap() {
  const it = items[cur];
  const id = ratioId();
  if (id !== 'free') {
    const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
    const [W, H] = dims(it);
    const [a, b] = id === 'custom' ? [field('rw').value, field('rh').value] : id === 'original' ? [W / gcd(W, H), H / gcd(W, H)] : id.split(':');
    const next = radio('ratio', `${b}:${a}`);
    if (next) next.checked = true;
    else {
      field('rw').value = String(b);
      field('rh').value = String(a);
      radio('ratio', 'custom')!.checked = true;
    }
  }
  for (const x of items) {
    const c = x.crop;
    x.crop = { x: c.x + (c.w - c.h) / 2, y: c.y + (c.h - c.w) / 2, w: c.h, h: c.w };
    clampCrop(x);
  }
  changed();
}

/** Unrotated full-resolution pixels to upload: the file itself when it is a raster, else a PNG. */
async function uploadBody(px: Pixels): Promise<Blob> {
  if (px.file && !px.svg) {
    const kind = await imageKind(px.file);
    // Type the body by its content, not the browser-reported MIME type.
    return px.file.slice(0, px.file.size, `image/${kind}`);
  }
  let canvas: HTMLCanvasElement;
  if (px.bitmap) {
    canvas = canvasOf(px.w, px.h);
    canvas.getContext('2d')!.drawImage(px.bitmap, 0, 0);
  } else {
    // Vector: at least 2048 px on the long side so the result is usable.
    const k = Math.min(Math.sqrt(MAX_PIXELS / (px.w * px.h)), Math.max(1, PREVIEW / Math.max(px.w, px.h)));
    canvas = await rasterizeSvg(px.file!, Math.round(px.w * k), Math.round(px.h * k));
  }
  return encodeCanvas(canvas, 'image/png');
}

async function removeBackground() {
  const it = items[cur];
  if (!it || busy || !API_URL) return;
  if (!(await confirmUpload())) return;
  const controller = new AbortController();
  bgJob = controller;
  busy = true;
  readouts();
  ui.busy.hidden = false;
  ui.dial.hidden = false;
  const progress = (text: string, f?: number) => {
    ui.busyText.textContent = text;
    setDial(ui.dial, f);
  };
  progress('Preparing…');
  try {
    const body = await uploadBody(it.px);
    if (body.size > BG_MAX_BYTES) throw new UserError('Background removal takes images up to 20 MB.');
    progress('Uploading… 0%', 0);
    const blob = await uploadForResult('/v1/remove-background', body, {
      signal: controller.signal,
      onUploadProgress: (f) => (f < 1 ? progress(`Uploading… ${Math.round(f * 100)}%`, f) : progress('Removing the background on the server…')),
      messages: {
        413: 'The image is larger than 20 MB.',
        415: 'This file is not a JPEG, PNG or WebP image.',
        422: 'The image could not be processed. It may be damaged or larger than 24 megapixels.',
        504: 'Processing took too long. Try a smaller image.',
      },
    });
    const px = await filePixels(new File([blob], `${baseName(it)}-no-background.png`, { type: 'image/png' }));
    if (!items.includes(it)) return freePixels(px);
    const [W0, H0] = dims(it);
    pushHistory(it);
    const next: Item = { ...it, px };
    const [W1, H1] = dims(next);
    const c = it.crop;
    next.crop = { x: (c.x * W1) / W0, y: (c.y * H1) / H0, w: (c.w * W1) / W0, h: (c.h * H1) / H0 };
    setState(it, next);
    inspect(it, px);
    let note = 'Background removed.';
    if (format() === 'image/jpeg') {
      (ui.form.elements.namedItem('format') as HTMLSelectElement).value = 'image/png';
      note += ' Switched to PNG to keep the transparency.';
      changed();
    }
    setStatus(note, 'done');
  } catch (err) {
    setStatus(err instanceof DOMException && err.name === 'AbortError' ? 'Cancelled. Nothing was changed.' : message(err), 'error');
  } finally {
    bgJob = undefined;
    busy = false;
    ui.busy.hidden = true;
    readouts();
    requestDraw();
  }
}

function renderThumbs() {
  ui.thumbs.replaceChildren(
    ...items.map((it, i) => {
      const b = el('button', { type: 'button', className: 'ie-thumb checker', ariaLabel: `Edit ${it.origin.name}`, title: it.origin.name }, el('img', { src: it.px.url, alt: '' }));
      b.onclick = () => select(i);
      return el('li', {}, b);
    }),
  );
  ui.thumbs.hidden = items.length < 2;
}

function select(i: number) {
  cur = i;
  changed();
}

function removeCurrent() {
  const it = items[cur];
  if (!it || busy) return;
  discard(it);
  items.splice(cur, 1);
  cur = Math.min(cur, Math.max(0, items.length - 1));
  estGen++;
  renderThumbs();
  changed();
  setStatus('');
  if (!items.length) ui.canvas.getContext('2d')?.clearRect(0, 0, ui.canvas.width, ui.canvas.height);
}

async function addFiles(files: File[]) {
  if (!files.length || busy) return;
  setStatus('Opening…', 'working');
  const errors: string[] = [];
  const first = items.length;
  for (const f of files) {
    try {
      items.push(await load(f));
    } catch (err) {
      if (!(err instanceof UserError)) console.error(err);
      errors.push(err instanceof UserError ? err.message : `${f.name} could not be opened.`);
    }
  }
  if (items.length > first) cur = first;
  renderThumbs();
  changed();
  setStatus(errors.join('\n'), errors.length ? 'error' : 'idle');
}

async function run(task: () => Promise<void>) {
  if (busy) return;
  busy = true;
  readouts();
  try {
    await task();
  } catch (err) {
    setStatus(message(err), 'error');
  } finally {
    busy = false;
    readouts();
    requestDraw();
  }
}

function onInput(t: HTMLInputElement) {
  const it = items[cur];
  const v = Number(t.value);
  if (t.name === 'zoom' && it) setZoom(it, v);
  else if (t.name === 'ratio' || t.name === 'fit' || t.name === 'rw' || t.name === 'rh') items.forEach(resetCrop);
  else if (t.name === 'size') size = t.value === 'original' ? { kind: 'original' } : { kind: 'long', n: v };
  else if (t.name === 'scale' || (t.name === 'pct' && v > 0)) size = { kind: 'pct', p: v };
  else if ((t.name === 'cw' || t.name === 'ch') && v >= 1) size = { kind: 'px', axis: t.name === 'cw' ? 'w' : 'h', v: Math.round(v) };
  changed(t.name);
}

/** Wire up the editor markup once; it starts empty with its own drop target. */
export function initImageEditor(): void {
  if (root) return;
  const r = document.querySelector<HTMLElement>('[data-image-editor]');
  if (!r) throw new Error('ImageEditor markup missing');
  root = r;
  ui = bind(r);
  const { form, canvas } = ui;
  linkQuality(field('quality'), ui.qualityNum);

  const prefs = loadPrefs();
  (radio('ratio', prefs.editorRatio ?? '') ?? radio('ratio', 'original')!).checked = true;
  const n = Number(prefs.editorSize);
  if (n > 0) size = { kind: 'long', n };
  (form.elements.namedItem('format') as HTMLSelectElement).value = prefs.imageFormat ?? 'image/webp';
  field('quality').value = ui.qualityNum.value = String(prefs.imageQuality ?? 82);

  form.addEventListener('submit', (e) => e.preventDefault());
  form.addEventListener('input', (e) => onInput(e.target as HTMLInputElement));
  // Write clamped values back once the user leaves a field.
  form.addEventListener('change', () => syncControls());

  const pickers = r.querySelectorAll<HTMLInputElement>('[data-input], [data-add]');
  pickers.forEach((input) =>
    input.addEventListener('change', () => {
      const files = [...(input.files ?? [])];
      input.value = '';
      void addFiles(files);
    }),
  );
  r.addEventListener('dragover', (e) => {
    e.preventDefault();
    r.classList.add('ie-over');
  });
  r.addEventListener('dragleave', (e) => {
    if (!r.contains(e.relatedTarget as Node | null)) r.classList.remove('ie-over');
  });
  r.addEventListener('drop', (e) => {
    e.preventDefault();
    r.classList.remove('ie-over');
    void addFiles([...(e.dataTransfer?.files ?? [])]);
  });
  document.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files ?? [])];
    if (files.length) void addFiles(files);
  });

  const onEach = (sel: string, fn: () => void) => r.querySelectorAll(sel).forEach((b) => b.addEventListener('click', fn));
  onEach('[data-rotate-left]', () => rotate(-1));
  onEach('[data-rotate-right]', () => rotate(1));
  onEach('[data-flip]', () => flip(false));
  onEach('[data-flip-v]', () => flip(true));
  onEach('[data-swap]', swap);
  onEach('[data-zoom-out]', () => zoomBy(items[cur], 1 / 1.25));
  onEach('[data-zoom-in]', () => zoomBy(items[cur], 1.25));
  onEach('[data-reset]', () => {
    resetCrop(items[cur]);
    changed();
  });
  onEach('[data-crop-apply]', () => void bake('crop'));
  onEach('[data-cut]', () => void bake('cut'));
  onEach('[data-undo]', () => step(true));
  onEach('[data-redo]', () => step(false));
  onEach('[data-remove-image]', removeCurrent);
  onEach('[data-remove-bg]', () => void removeBackground());
  onEach('[data-busy-cancel]', () => bgJob?.abort());

  // Undo/redo anywhere in the editor except while typing in a field.
  r.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.key.toLowerCase() !== 'z') return;
    if ((e.target as Element).closest('input, select, textarea')) return;
    e.preventDefault();
    step(!e.shiftKey);
  });

  ui.download.addEventListener('click', () =>
    run(async () => {
      const it = items[cur];
      setStatus('Preparing download…', 'working');
      const { blob, note } = await exportBlob(it);
      downloadBlob(blob, outName(it));
      setStatus(`Saved ${outName(it)}.${note ? ` ${note}` : ''}`, 'done');
    }),
  );
  ui.downloadAll.addEventListener('click', () =>
    run(async () => {
      const entries: Zippable = {};
      const failed: string[] = [];
      const taken = new Set<string>();
      for (const [i, it] of items.entries()) {
        setStatus(`Preparing ${i + 1} of ${items.length}…`, 'working');
        try {
          const { blob, note } = await exportBlob(it);
          entries[uniqueName(outName(it), taken)] = new Uint8Array(await blob.arrayBuffer());
          if (note) failed.push(it.origin.name);
        } catch (err) {
          throw err instanceof UserError ? new UserError(`${it.origin.name}: ${err.message}`) : err;
        }
      }
      // Images are already compressed, so store without deflate.
      const zip = zipSync(entries, { level: 0 });
      downloadBlob(new Blob([zip as BlobPart], { type: 'application/zip' }), 'images.zip');
      setStatus(`Saved images.zip with ${items.length} images.${failed.length ? ` Metadata could not be kept for ${failed.join(', ')}.` : ''}`, 'done');
    }),
  );

  // Settings sidebar width; the canvas keeps at least 320 px.
  resizable(ui.resizer, {
    key: 'images.side',
    min: () => 280,
    max: () => Math.max(280, Math.min(640, r.clientWidth - 320)),
    initial: 340,
    apply: (px) => r.style.setProperty('--ie-side', `${px}px`),
    fromPointer: (e, start) => start.size - (e.clientX - start.x),
    growKey: 'ArrowLeft',
    shrinkKey: 'ArrowRight',
    container: r,
  });

  // Stage: one pointer moves the crop or drags a handle, two pinch-zoom.
  const pointers = new Map<number, { x: number; y: number }>();
  let gesture: { grab: Handle | 'move'; x: number; y: number; crop: Rect; zoom: number; dist: number } | undefined;
  const startGesture = (grab: Handle | 'move' = 'move') => {
    const it = items[cur];
    const [a, b] = pointers.values();
    gesture = a && it ? { grab: b ? 'move' : grab, x: a.x, y: a.y, crop: { ...it.crop }, zoom: zoomOf(it), dist: b ? Math.hypot(a.x - b.x, a.y - b.y) : 0 } : undefined;
  };
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !items[cur] || busy) return;
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    dragging = true;
    startGesture(hitTest(e.clientX, e.clientY));
  });
  canvas.addEventListener('pointermove', (e) => {
    const it = items[cur];
    if (!it) return;
    if (!pointers.has(e.pointerId) || !gesture) {
      canvas.style.cursor = CURSORS[hitTest(e.clientX, e.clientY)];
      return;
    }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const [a, b] = pointers.values();
    const [dx, dy] = [a.x - gesture.x, a.y - gesture.y];
    if (b && gesture.dist) setZoom(it, (gesture.zoom * Math.hypot(a.x - b.x, a.y - b.y)) / gesture.dist);
    else if (gesture.grab === 'move') moveBy(it, gesture.crop, dx, dy);
    else {
      resizeCrop(it, gesture.grab, gesture.crop, dx * stage.toWorld, dy * stage.toWorld);
      clampCrop(it);
    }
    syncControls();
    requestDraw();
  });
  const end = (e: PointerEvent) => {
    if (!pointers.delete(e.pointerId)) return;
    startGesture();
    if (pointers.size) return;
    dragging = false;
    readouts();
    requestDraw();
    scheduleEstimate();
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener(
    'wheel',
    (e) => {
      if (!items[cur]) return;
      e.preventDefault();
      zoomBy(items[cur], Math.exp(-e.deltaY * 0.002));
    },
    { passive: false },
  );
  canvas.addEventListener('keydown', (e) => {
    const it = items[cur];
    if (!it || e.ctrlKey || e.metaKey || e.altKey) return;
    const step = e.shiftKey ? 50 : 10;
    const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[e.key]) {
      moveBy(it, it.crop, ...moves[e.key]);
      changed();
    } else if (e.key === '+' || e.key === '=') zoomBy(it, 1.1);
    else if (e.key === '-') zoomBy(it, 1 / 1.1);
    else if (e.key === 'Enter') void bake('crop');
    else if (e.key === 'Delete' || e.key === 'Backspace') void bake('cut');
    else return;
    e.preventDefault();
  });
  new ResizeObserver(() => {
    const dpr = devicePixelRatio || 1;
    canvas.width = Math.round(canvas.clientWidth * dpr);
    canvas.height = Math.round(canvas.clientHeight * dpr);
    draw();
  }).observe(canvas);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', refreshPalette);
  new MutationObserver(refreshPalette).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  refreshPalette();

  syncControls();
}
