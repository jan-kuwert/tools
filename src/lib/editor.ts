// Image editor: frame/crop, resize, rotate and convert, all on this device.
// Markup lives in src/components/ImageEditor.astro.
// Pan state (cx, cy) and sizes are in full-resolution pixels of the rotated image ("source px");
// the stage draws a ≤ PREVIEW px copy of it and export re-decodes the file at full resolution.
import { zipSync, type Zippable } from 'fflate';
import { canvasOf, decodeImage, drawImage, encodeCanvas, EXT, MAX_PIXELS, uniqueName, type ImageType, type Rect } from './image';
import { loadPrefs } from './prefs';
import { downloadBlob, el, formatBytes, UserError } from './tool';

export type FrameId = 'original' | 'square' | 'portrait' | 'story' | 'landscape' | '4:3' | '3:2' | 'custom';
export const FRAMES: Record<FrameId, { label: string; w?: number; h?: number }> = {
  original: { label: 'Original size' },
  square: { label: 'Square', w: 1080, h: 1080 },
  portrait: { label: 'Portrait 4:5', w: 1080, h: 1350 },
  story: { label: 'Story 9:16', w: 1080, h: 1920 },
  landscape: { label: 'Landscape 16:9', w: 1920, h: 1080 },
  '4:3': { label: '4:3', w: 1600, h: 1200 },
  '3:2': { label: '3:2', w: 1800, h: 1200 },
  custom: { label: 'Custom' },
};

const PREVIEW = 2048;
const ZOOM = { fill: [1, 8], fit: [0.1, 1] } as const;

type Source = ImageBitmap | HTMLCanvasElement;

interface Item {
  file: File;
  type: ImageType;
  url: string; // thumbnail
  w: number; // decoded size before rotation
  h: number;
  base: HTMLCanvasElement; // preview, unrotated
  view: HTMLCanvasElement; // preview with rot/flip applied
  rot: number; // quarter turns clockwise, applied before flip
  flip: boolean;
  zoom: number;
  cx: number; // source point shown at the frame centre, relative to the image centre
  cy: number;
  outW: number; // "Original size" output
  outH: number;
}

let root: HTMLElement | undefined;
let ui: ReturnType<typeof bind>;
let items: Item[] = [];
let cur = 0;
let full: { item: Item; rot: number; flip: boolean; src: Promise<Source> } | undefined;
let raf = 0;
let pxToWorld = 1;
let estTimer = 0;
let estGen = 0;
let busy = false;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const discard = (list: Item[]) =>
  list.forEach((it) => {
    it.base.width = 0;
    it.view.width = 0;
    URL.revokeObjectURL(it.url);
  });

function bind(root: HTMLElement) {
  const q = <T extends Element = HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  const form = q<HTMLFormElement>('[data-form]');
  return {
    form,
    canvas: q<HTMLCanvasElement>('[data-canvas]'),
    name: q('[data-name]'),
    thumbs: q('[data-thumbs]'),
    crop: q('[data-crop]'),
    zoomCtl: q('[data-zoom-controls]'),
    fitSet: q('[data-fit-set]'),
    custom: q('[data-custom]'),
    resize: q('[data-resize]'),
    bgSet: q('[data-bg-set]'),
    qualityOut: q('[data-quality-out]'),
    jpegWarn: q('[data-jpeg-warn]'),
    problem: q('[data-problem]'),
    dims: q('[data-dims]'),
    estimate: q('[data-estimate]'),
    download: q<HTMLButtonElement>('[data-download]'),
    downloadAll: q<HTMLButtonElement>('[data-download-all]'),
    status: q('[data-status]'),
    add: q<HTMLInputElement>('[data-add]'),
  };
}

const field = (name: string) => ui.form.elements.namedItem(name) as HTMLInputElement;
const value = (name: string) => (ui.form.elements.namedItem(name) as RadioNodeList | HTMLInputElement).value;
const frameId = () => value('frame') as FrameId;
const format = () => value('format') as ImageType;
const quality = () => Number(field('quality').value) / 100;
/** Colour behind transparent pixels and padding; JPEG has no alpha so it always gets one. */
const background = () => (format() === 'image/jpeg' || value('bg') === 'colour' ? field('colour').value : undefined);

const dims = (it: Item) => (it.rot % 2 ? [it.h, it.w] : [it.w, it.h]);

function outSize(it: Item): [number, number] {
  const id = frameId();
  if (id === 'original') return [it.outW, it.outH];
  if (id === 'custom') return [Math.round(Number(field('cw').value)), Math.round(Number(field('ch').value))];
  return [FRAMES[id].w!, FRAMES[id].h!];
}

function geometry(it: Item) {
  const [W, H] = dims(it);
  const [FW, FH] = outSize(it);
  const original = frameId() === 'original';
  const fill = value('fit') === 'fill';
  const cover = fill ? Math.max(FW / W, FH / H) : Math.min(FW / W, FH / H);
  return { W, H, FW, FH, original, fill, s: cover * it.zoom };
}

function problem(it: Item): string | undefined {
  const [w, h] = outSize(it);
  if (!(w >= 1 && h >= 1)) return 'Enter an output width and height of at least 1 px.';
  if (w * h > MAX_PIXELS) return `${w} × ${h} px is above the 16.7 megapixel limit that works on every device, including iPhone and iPad.`;
}

/** Keep zoom in range and, with Fill, the frame inside the image; with Fit, the image inside the frame. */
function clampView(it: Item) {
  if (problem(it)) return;
  const [lo, hi] = ZOOM[value('fit') === 'fill' ? 'fill' : 'fit'];
  it.zoom = clamp(it.zoom, lo, hi);
  const { W, H, FW, FH, fill, s } = geometry(it);
  const limX = fill ? Math.max(0, W - FW / s) / 2 : Math.abs(W - FW / s) / 2;
  const limY = fill ? Math.max(0, H - FH / s) / 2 : Math.abs(H - FH / s) / 2;
  it.cx = clamp(it.cx, -limX, limX);
  it.cy = clamp(it.cy, -limY, limY);
}

/** Rects in world units: source px with Fill (image fixed, frame moves), output px otherwise. */
function layout(it: Item): { box: Rect; img: Rect; frame: Rect } {
  const { W, H, FW, FH, original, fill, s } = geometry(it);
  if (original) {
    const r = { x: 0, y: 0, w: FW, h: FH };
    return { box: r, img: r, frame: r };
  }
  if (fill) {
    const img = { x: 0, y: 0, w: W, h: H };
    return { box: img, img, frame: { x: W / 2 + it.cx - FW / s / 2, y: H / 2 + it.cy - FH / s / 2, w: FW / s, h: FH / s } };
  }
  const frame = { x: 0, y: 0, w: FW, h: FH };
  return { box: frame, frame, img: { x: FW / 2 - (W / 2 + it.cx) * s, y: FH / 2 - (H / 2 + it.cy) * s, w: W * s, h: H * s } };
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

async function load(file: File): Promise<Item> {
  const { bitmap, type } = await decodeImage(file);
  try {
    const k = Math.min(1, PREVIEW / Math.max(bitmap.width, bitmap.height));
    const base = drawImage(bitmap, Math.max(1, Math.round(bitmap.width * k)), Math.max(1, Math.round(bitmap.height * k)));
    const { width: w, height: h } = bitmap;
    return { file, type, url: URL.createObjectURL(file), w, h, base, view: base, rot: 0, flip: false, zoom: 1, cx: 0, cy: 0, outW: w, outH: h };
  } finally {
    bitmap.close();
  }
}

async function loadAll(files: File[]): Promise<{ loaded: Item[]; errors: string[] }> {
  const loaded: Item[] = [];
  const errors: string[] = [];
  for (const f of files) {
    try {
      loaded.push(await load(f));
    } catch (err) {
      if (!(err instanceof UserError)) console.error(err);
      errors.push(err instanceof UserError ? err.message : `${f.name} could not be opened.`);
    }
  }
  return { loaded, errors };
}

function dropFull() {
  full?.src.then((s) => (s instanceof ImageBitmap ? s.close() : (s.width = 0)), () => {});
  full = undefined;
}

/** Full-resolution, rotated source. Only one is kept in memory. */
function fullOf(it: Item): Promise<Source> {
  if (full?.item === it && full.rot === it.rot && full.flip === it.flip) return full.src;
  dropFull();
  const src = decodeImage(it.file).then(({ bitmap }) => {
    const out = orient(bitmap, it.rot, it.flip);
    if (out !== bitmap) bitmap.close();
    return out;
  });
  full = { item: it, rot: it.rot, flip: it.flip, src };
  src.catch(() => full?.src === src && (full = undefined));
  return src;
}

function renderOutput(it: Item, src: Source): HTMLCanvasElement {
  const { W, H, FW, FH, original, s } = geometry(it);
  const bg = background();
  if (original) return drawImage(src, FW, FH, bg);
  const out = canvasOf(FW, FH);
  const ctx = out.getContext('2d')!;
  if (bg) {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, FW, FH);
  }
  const x0 = FW / 2 - (W / 2 + it.cx) * s;
  const y0 = FH / 2 - (H / 2 + it.cy) * s;
  const dx0 = Math.max(0, Math.round(x0));
  const dy0 = Math.max(0, Math.round(y0));
  const dx1 = Math.min(FW, Math.round(x0 + W * s));
  const dy1 = Math.min(FH, Math.round(y0 + H * s));
  if (dx1 > dx0 && dy1 > dy0) {
    // Crop first, then scale only the visible part: high-quality and never larger than the frame.
    const x = clamp((dx0 - x0) / s, 0, W);
    const y = clamp((dy0 - y0) / s, 0, H);
    const crop = { x, y, w: Math.min(W - x, (dx1 - dx0) / s), h: Math.min(H - y, (dy1 - dy0) / s) };
    const piece = drawImage(src, dx1 - dx0, dy1 - dy0, undefined, crop);
    ctx.drawImage(piece, dx0, dy0);
    piece.width = 0;
  }
  return out;
}

async function exportBlob(it: Item): Promise<Blob> {
  const p = problem(it);
  if (p) throw new UserError(p);
  clampView(it);
  const canvas = renderOutput(it, await fullOf(it));
  const type = format();
  return encodeCanvas(canvas, type, type === 'image/png' ? undefined : quality());
}

const outName = (it: Item) => {
  const [w, h] = outSize(it);
  return `${it.file.name.replace(/\.[^./]*$/, '') || 'image'}-${w}x${h}.${EXT[format()]}`;
};

// ---- Stage ----

let checker: { dpr: number; tile: HTMLCanvasElement } | undefined;
function checkerPattern(ctx: CanvasRenderingContext2D, dpr: number) {
  if (checker?.dpr !== dpr) {
    const n = Math.round(8 * dpr);
    const tile = canvasOf(2 * n, 2 * n);
    const t = tile.getContext('2d')!;
    t.fillStyle = '#3c3d42';
    t.fillRect(0, 0, 2 * n, 2 * n);
    t.fillStyle = '#4d4e54';
    t.fillRect(0, 0, n, n);
    t.fillRect(n, n, n, n);
    checker = { dpr, tile };
  }
  return ctx.createPattern(checker.tile, 'repeat')!;
}

function draw() {
  raf = 0;
  const it = items[cur];
  const { canvas } = ui;
  const ctx = canvas.getContext('2d');
  if (!it || !ctx || !canvas.width) return;
  const { width: cw, height: ch } = canvas;
  ctx.clearRect(0, 0, cw, ch);
  if (problem(it)) return;
  const dpr = cw / canvas.clientWidth;
  const g = geometry(it);
  const L = layout(it);
  const pad = 20 * dpr;
  const vs = Math.min((cw - 2 * pad) / L.box.w, (ch - 2 * pad) / L.box.h);
  pxToWorld = dpr / vs;
  const ox = (cw - L.box.w * vs) / 2 - L.box.x * vs;
  const oy = (ch - L.box.h * vs) / 2 - L.box.y * vs;
  const d = (r: Rect): Rect => ({ x: ox + r.x * vs, y: oy + r.y * vs, w: r.w * vs, h: r.h * vs });
  const img = d(L.img);
  const frame = d(L.frame);
  const back = g.fill && !g.original ? img : frame;

  ctx.fillStyle = background() ?? checkerPattern(ctx, dpr);
  ctx.fillRect(back.x, back.y, back.w, back.h);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(it.view, img.x, img.y, img.w, img.h);
  if (g.original) return;

  if (g.fill) {
    ctx.beginPath();
    ctx.rect(img.x, img.y, img.w, img.h);
    ctx.rect(frame.x, frame.y, frame.w, frame.h);
    ctx.fillStyle = 'rgb(14 14 18 / 0.62)';
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
  ctx.strokeStyle = 'rgb(255 255 255 / 0.28)';
  ctx.stroke();
  ctx.lineWidth = 3 * dpr;
  ctx.strokeStyle = 'rgb(0 0 0 / 0.45)';
  ctx.strokeRect(frame.x, frame.y, frame.w, frame.h);
  ctx.lineWidth = 1.5 * dpr;
  ctx.strokeStyle = '#fff';
  ctx.strokeRect(frame.x, frame.y, frame.w, frame.h);
}

const requestDraw = () => (raf ||= requestAnimationFrame(draw));

/** Move by CSS px on screen: with Fill the frame follows the pointer, with Fit the image does. */
function moveBy(it: Item, from: { cx: number; cy: number }, dx: number, dy: number) {
  const g = geometry(it);
  const k = g.fill ? pxToWorld : -pxToWorld / g.s;
  it.cx = from.cx + dx * k;
  it.cy = from.cy + dy * k;
}

function zoomBy(it: Item, factor: number) {
  it.zoom *= factor;
  changed();
}

// ---- UI sync ----

function readouts() {
  const it = items[cur];
  if (!it) return;
  const err = problem(it);
  const [W, H] = dims(it);
  const [FW, FH] = outSize(it);
  const g = geometry(it);
  ui.name.textContent = items.length > 1 ? `${it.file.name} (${cur + 1} of ${items.length})` : it.file.name;
  ui.dims.textContent = err ? '–' : `${FW} × ${FH} px`;
  ui.problem.textContent = err ?? '';
  ui.problem.hidden = !err;
  const zoom = field('zoom');
  const [lo, hi] = ZOOM[g.fill ? 'fill' : 'fit'];
  zoom.min = String(lo);
  zoom.max = String(hi);
  zoom.value = String(it.zoom);
  zoom.setAttribute('aria-valuetext', `${Math.round(g.s * 100)}% of original pixels`);
  const pct = `${Math.round(g.s * 100)}%`;
  if (err) ui.crop.textContent = '';
  else if (g.original) ui.crop.textContent = `${W} × ${H} → ${FW} × ${FH} px`;
  else {
    const L = layout(it);
    const r = g.fill ? L.frame : L.img;
    const [x, y, w, h] = [r.x, r.y, r.w, r.h].map(Math.round);
    ui.crop.textContent = g.fill ? `Crop ${w} × ${h} px from ${x}, ${y} · scaled to ${pct}` : `Image ${w} × ${h} px at ${x}, ${y} in frame · scaled to ${pct}`;
  }
  ui.download.disabled = ui.downloadAll.disabled = busy || !!err;
}

/** Show/hide and refill controls. `editing` is the field being typed in; it is left alone. */
function syncControls(editing?: string) {
  const id = frameId();
  const original = id === 'original';
  const jpeg = format() === 'image/jpeg';
  const png = format() === 'image/png';
  ui.custom.hidden = id !== 'custom';
  ui.resize.hidden = !original;
  ui.fitSet.hidden = ui.zoomCtl.hidden = original;
  ui.bgSet.hidden = jpeg;
  field('colour').disabled = !jpeg && value('bg') !== 'colour';
  field('quality').disabled = png;
  ui.qualityOut.textContent = png ? 'lossless' : field('quality').value;
  ui.jpegWarn.hidden = !jpeg || items.every((it) => it.type === 'image/jpeg');
  ui.downloadAll.hidden = items.length < 2;
  const it = items[cur];
  if (it && original) {
    const [W] = dims(it);
    const vals: Record<string, number> = { ow: it.outW, oh: it.outH, pct: Math.round((it.outW / W) * 1000) / 10 };
    for (const [name, v] of Object.entries(vals)) if (name !== editing) field(name).value = String(v);
    field('pct').max = field('upscale').checked ? '' : '100';
  }
  ui.thumbs.querySelectorAll<HTMLButtonElement>('button').forEach((b, i) => {
    b.ariaCurrent = i === cur ? 'true' : null;
    const t = items[i];
    b.querySelector('img')!.style.transform = `${t.flip ? 'scaleX(-1) ' : ''}rotate(${t.rot * 90}deg)`;
  });
}

function changed() {
  const it = items[cur];
  if (ui.status.dataset.kind === 'done') setStatus('');
  if (!it) return;
  clampView(it);
  readouts();
  requestDraw();
  scheduleEstimate();
}

function scheduleEstimate() {
  const it = items[cur];
  clearTimeout(estTimer);
  const gen = ++estGen;
  const err = problem(it);
  ui.estimate.textContent = err ? '–' : 'calculating…';
  if (err) return;
  estTimer = window.setTimeout(async () => {
    try {
      const blob = await exportBlob(it);
      if (gen !== estGen) return;
      const pct = Math.round((blob.size / it.file.size - 1) * 100);
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

function setSize(it: Item, axis: 'w' | 'h', v: number) {
  if (!(v >= 1)) return;
  const [W, H] = dims(it);
  const lock = field('lock').checked;
  v = Math.round(v);
  if (!field('upscale').checked) v = Math.min(v, axis === 'w' ? W : H);
  if (axis === 'w') {
    it.outW = v;
    if (lock) it.outH = Math.max(1, Math.round((v * H) / W));
  } else {
    it.outH = v;
    if (lock) it.outW = Math.max(1, Math.round((v * W) / H));
  }
}

function scaleTo(it: Item, pct: number) {
  if (!(pct > 0)) return;
  const [W, H] = dims(it);
  const k = field('upscale').checked ? pct / 100 : Math.min(1, pct / 100);
  it.outW = Math.max(1, Math.round(W * k));
  it.outH = Math.max(1, Math.round(H * k));
}

function rotate(d: 1 | -1) {
  const it = items[cur];
  // Rotation is applied before the flip, so a visual turn runs the other way while flipped.
  it.rot = (it.rot + (it.flip ? -d : d) + 4) % 4;
  [it.cx, it.cy] = d > 0 ? [-it.cy, it.cx] : [it.cy, -it.cx];
  [it.outW, it.outH] = [it.outH, it.outW];
  reorient(it);
}

function flip() {
  const it = items[cur];
  it.flip = !it.flip;
  it.cx = -it.cx;
  reorient(it);
}

function reorient(it: Item) {
  if (it.view !== it.base) it.view.width = 0;
  it.view = orient(it.base, it.rot, it.flip);
  syncControls();
  changed();
}

function renderThumbs() {
  ui.thumbs.replaceChildren(
    ...items.map((it, i) => {
      const b = el('button', { type: 'button', className: 'ie-thumb', ariaLabel: `Edit ${it.file.name}`, title: it.file.name }, el('img', { src: it.url, alt: '' }));
      b.onclick = () => select(i);
      return el('li', {}, b);
    }),
  );
  ui.thumbs.hidden = items.length < 2;
}

function select(i: number) {
  cur = i;
  syncControls();
  changed();
}

function release() {
  discard(items);
  items = [];
  dropFull();
  clearTimeout(estTimer);
  estGen++;
}

async function addFiles(files: File[]) {
  if (!files.length) return;
  setStatus('Opening…', 'working');
  const { loaded, errors } = await loadAll(files);
  if (!root || root.hidden) return discard(loaded); // closed while decoding
  items.push(...loaded);
  if (loaded.length) cur = items.length - loaded.length;
  renderThumbs();
  syncControls();
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
  }
}

function close() {
  release();
  root!.hidden = true;
  root!.dispatchEvent(new CustomEvent('editor:close'));
}

function init(): HTMLElement {
  if (root) return root;
  const r = document.querySelector<HTMLElement>('[data-image-editor]');
  if (!r) throw new Error('ImageEditor markup missing');
  root = r;
  ui = bind(r);
  const { form, canvas } = ui;

  form.addEventListener('submit', (e) => e.preventDefault());
  form.addEventListener('input', (e) => {
    const t = e.target as HTMLInputElement;
    const it = items[cur];
    if (!it) return;
    if (t.name === 'zoom') it.zoom = Number(t.value);
    else if (t.name === 'ow') setSize(it, 'w', Number(t.value));
    else if (t.name === 'oh') setSize(it, 'h', Number(t.value));
    else if (t.name === 'pct') items.forEach((x) => scaleTo(x, Number(t.value)));
    else if (t.name === 'lock' || t.name === 'upscale')
      for (const x of items) {
        setSize(x, 'w', x.outW);
        if (!field('lock').checked) setSize(x, 'h', x.outH);
      }
    syncControls(t.name);
    changed();
  });
  // Write clamped values back once the user leaves a field.
  form.addEventListener('change', () => syncControls());

  r.querySelector('[data-close]')!.addEventListener('click', close);
  r.querySelector('[data-rotate-left]')!.addEventListener('click', () => rotate(-1));
  r.querySelector('[data-rotate-right]')!.addEventListener('click', () => rotate(1));
  r.querySelector('[data-flip]')!.addEventListener('click', flip);
  r.querySelector('[data-zoom-out]')!.addEventListener('click', () => zoomBy(items[cur], 1 / 1.25));
  r.querySelector('[data-zoom-in]')!.addEventListener('click', () => zoomBy(items[cur], 1.25));
  r.querySelector('[data-reset]')!.addEventListener('click', () => {
    Object.assign(items[cur], { zoom: 1, cx: 0, cy: 0 });
    changed();
  });
  ui.add.addEventListener('change', () => {
    const files = [...(ui.add.files ?? [])];
    ui.add.value = '';
    void addFiles(files);
  });
  r.addEventListener('dragover', (e) => e.preventDefault());
  r.addEventListener('drop', (e) => {
    e.preventDefault();
    void addFiles([...(e.dataTransfer?.files ?? [])]);
  });

  ui.download.addEventListener('click', () =>
    run(async () => {
      const it = items[cur];
      setStatus('Preparing download…', 'working');
      downloadBlob(await exportBlob(it), outName(it));
      setStatus(`Saved ${outName(it)}.`, 'done');
    }),
  );
  ui.downloadAll.addEventListener('click', () =>
    run(async () => {
      const entries: Zippable = {};
      const taken = new Set<string>();
      for (const [i, it] of items.entries()) {
        setStatus(`Preparing ${i + 1} of ${items.length}…`, 'working');
        try {
          entries[uniqueName(outName(it), taken)] = new Uint8Array(await (await exportBlob(it)).arrayBuffer());
        } catch (err) {
          throw err instanceof UserError ? new UserError(`${it.file.name}: ${err.message}`) : err;
        }
      }
      // Images are already compressed, so store without deflate.
      const zip = zipSync(entries, { level: 0 });
      downloadBlob(new Blob([zip as BlobPart], { type: 'application/zip' }), 'images.zip');
      setStatus(`Saved images.zip with ${items.length} images.`, 'done');
    }),
  );

  // Stage: pointer drag (one finger/mouse) pans, two fingers pinch-zoom.
  const pointers = new Map<number, { x: number; y: number }>();
  let gesture: { x: number; y: number; cx: number; cy: number; zoom: number; dist: number } | undefined;
  const startGesture = () => {
    const it = items[cur];
    const [a, b] = pointers.values();
    gesture = a && it ? { x: a.x, y: a.y, cx: it.cx, cy: it.cy, zoom: it.zoom, dist: b ? Math.hypot(a.x - b.x, a.y - b.y) : 0 } : undefined;
  };
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || frameId() === 'original') return;
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    startGesture();
  });
  canvas.addEventListener('pointermove', (e) => {
    const it = items[cur];
    if (!pointers.has(e.pointerId) || !gesture || !it) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const [a, b] = pointers.values();
    if (b && gesture.dist) it.zoom = (gesture.zoom * Math.hypot(a.x - b.x, a.y - b.y)) / gesture.dist;
    else moveBy(it, gesture, a.x - gesture.x, a.y - gesture.y);
    clampView(it);
    readouts();
    requestDraw();
  });
  const end = (e: PointerEvent) => {
    if (!pointers.delete(e.pointerId)) return;
    startGesture();
    if (!pointers.size) scheduleEstimate();
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener(
    'wheel',
    (e) => {
      if (!items[cur] || frameId() === 'original') return;
      e.preventDefault();
      zoomBy(items[cur], Math.exp(-e.deltaY * 0.002));
    },
    { passive: false },
  );
  canvas.addEventListener('keydown', (e) => {
    const it = items[cur];
    if (!it || frameId() === 'original') return;
    const step = e.shiftKey ? 50 : 10;
    const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[e.key]) {
      moveBy(it, it, ...moves[e.key]);
      changed();
    } else if (e.key === '+' || e.key === '=') zoomBy(it, 1.1);
    else if (e.key === '-') zoomBy(it, 1 / 1.1);
    else return;
    e.preventDefault();
  });
  new ResizeObserver(() => {
    const dpr = devicePixelRatio || 1;
    canvas.width = Math.round(canvas.clientWidth * dpr);
    canvas.height = Math.round(canvas.clientHeight * dpr);
    draw();
  }).observe(canvas);
  return r;
}

/** Open the editor with these images, replacing any already open. Throws UserError if none can be opened. */
export async function openImageEditor(files: File[]): Promise<void> {
  const r = init();
  const { loaded, errors } = await loadAll(files);
  if (!loaded.length) throw new UserError(errors.join('\n') || 'Choose at least one JPEG, PNG or WebP image.');
  release();
  items = loaded;
  cur = 0;
  const prefs = loadPrefs();
  const frame = prefs.editorFrame && prefs.editorFrame in FRAMES ? prefs.editorFrame : 'original';
  ui.form.querySelector<HTMLInputElement>(`[name=frame][value="${frame}"]`)!.checked = true;
  ui.form.querySelector<HTMLInputElement>(`[name=format][value="${prefs.imageFormat ?? 'image/webp'}"]`)!.checked = true;
  field('quality').value = String(prefs.imageQuality ?? 82);
  r.hidden = false;
  renderThumbs();
  syncControls();
  changed();
  setStatus(errors.join('\n'), errors.length ? 'error' : 'idle');
  r.focus({ preventScroll: true });
  r.scrollIntoView({ block: 'start' });
}
