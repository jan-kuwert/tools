// GPX app (src/pages/gpx/index.astro): track list, canvas map and profile, inspector with edits, clean-up, merge and export.
// No map tiles (CSP and privacy): the map is a Web-Mercator canvas with a graticule, scale bar and north arrow.
import { downloadBlob, el, UserError } from './tool';
import {
  count,
  cut,
  deletePoint,
  findOutliers,
  flatten,
  insertPoint,
  MAX_BYTES,
  merge,
  movePoint,
  overlaps,
  parseGpx,
  privacy,
  removePauses,
  removePoints,
  removeSpikes,
  reverse,
  serializeGpx,
  shiftTime,
  simplify,
  smoothElevation,
  split,
  stats,
  trim,
  type Flat,
  type Stats,
  type Track,
  type Wpt,
} from './gpx';

interface Item { id: number; t: Track; color: string; hidden: boolean; wpts: Wpt[]; ns: Record<string, string> }
interface Derived extends Flat { stats: Stats; wx: Float64Array; wy: Float64Array; hasEle: boolean; hasHr: boolean; minHr: number }
interface Snap { items: Item[]; activeId: number; ticked: number[] }

// First colours stay clear of the red heart-rate line and the green/red start and end markers.
const COLORS = ['#2e86de', '#e67e22', '#8e44ad', '#16a085', '#d63384', '#5b8c2a', '#0097a7', '#e4572e'];
const START = '#1f9d63';
const END = '#e5484d';
const HR = '#e5484d';
const RAD = Math.PI / 180;
const MIN_S = 256;
const MAX_S = 256 * 2 ** 23;
const FIT_MAX_S = 256 * 2 ** 18;
// Profile plot margins (px).
const PL = 46;
const PR = 40;
const PT = 12;
const PB = 20;

const mx = (lon: number) => (lon + 180) / 360;
const my = (lat: number) => {
  const s = Math.sin(Math.max(-85.05, Math.min(85.05, lat)) * RAD);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
};
const lonOf = (x: number) => x * 360 - 180;
const latOf = (y: number) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) / RAD;

const pad2 = (n: number) => String(n).padStart(2, '0');
const km = (m: number) => (m >= 10_000 ? `${(m / 1000).toFixed(1)} km` : m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`);
const dur = (ms: number) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 3600)}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}`;
};
const pace = (mps: number) => {
  const s = Math.round(1000 / mps);
  return `${Math.floor(s / 60)}:${pad2(s % 60)} /km`;
};
const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const timeFmt = new Intl.DateTimeFormat(undefined, { timeStyle: 'medium' });
const dayFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
/** 1, 2 or 5 × 10^k, the largest not above `v`. */
const nice = (v: number) => {
  const p = 10 ** Math.floor(Math.log10(v));
  return [5, 2, 1].map((m) => m * p).find((x) => x <= v) ?? p;
};
const fileName = (name: string) => (name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').trim() || 'track') + '.gpx';
const toLocalInput = (ms: number) => new Date(ms - new Date(ms).getTimezoneOffset() * 60_000).toISOString().slice(0, 19);

const derived = new WeakMap<Track, Derived>();
function info(t: Track): Derived {
  let d = derived.get(t);
  if (!d) {
    const f = flatten(t);
    const wx = new Float64Array(f.pts.length);
    const wy = new Float64Array(f.pts.length);
    f.pts.forEach((p, i) => ((wx[i] = mx(p.lon)), (wy[i] = my(p.lat))));
    const minHr = f.pts.reduce((m, p) => (p.hr !== undefined && p.hr < m ? p.hr : m), Infinity);
    d = { ...f, stats: stats(t, f), wx, wy, hasEle: f.pts.some((p) => p.ele !== undefined), hasHr: minHr < Infinity, minHr };
    derived.set(t, d);
  }
  return d;
}

/** Nearest index to `m` metres along the track. */
function indexAt(d: Derived, m: number): number {
  let lo = 0;
  let hi = d.dist.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (d.dist[mid] < m) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 && m - d.dist[lo - 1] < d.dist[lo] - m ? lo - 1 : lo;
}

function tipLines(d: Derived, i: number): string[] {
  const p = d.pts[i];
  const out: string[] = [];
  if (p.time !== undefined) out.push(timeFmt.format(p.time) + (d.stats.start !== undefined ? ` · +${dur(p.time - d.stats.start)}` : ''));
  out.push(km(d.dist[i]) + (p.ele !== undefined ? ` · ${Math.round(p.ele)} m` : ''));
  const extra = [p.hr !== undefined ? `${p.hr} bpm` : '', p.cad !== undefined ? `cadence ${p.cad}` : ''].filter(Boolean);
  if (extra.length) out.push(extra.join(' · '));
  return out;
}

export function initGpxApp(): void {
  const root = document.querySelector<HTMLElement>('[data-gpx-app]')!;
  const $ = <T extends Element = HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  const input = $<HTMLInputElement>('[data-input]');
  const list = $<HTMLOListElement>('[data-list]');
  const map = $('[data-map]');
  const mapCanvas = $<HTMLCanvasElement>('[data-map-canvas]');
  const tip = $('[data-tip]');
  const prof = $('[data-prof]');
  const profCanvas = $<HTMLCanvasElement>('[data-prof-canvas]');
  const profRead = $('[data-prof-read]');
  const msg = $('[data-msg]');
  const msgText = $('[data-msg-text]');
  const undoBtn = $<HTMLButtonElement>('[data-undo]');
  const redoBtn = $<HTMLButtonElement>('[data-redo]');
  const fitBtn = $<HTMLButtonElement>('[data-fit]');
  const closeAll = $<HTMLButtonElement>('[data-close-all]');
  const toggles = {
    points: $<HTMLButtonElement>('[data-toggle="points"]'),
    profile: $<HTMLButtonElement>('[data-toggle="profile"]'),
    hr: $<HTMLButtonElement>('[data-toggle="hr"]'),
  };
  const insp = $('[data-insp]');
  const nameInput = $<HTMLInputElement>('[data-name]');
  const typeInput = $<HTMLInputElement>('[data-type]');
  const statsList = $('[data-stats]');
  const selInfo = $('[data-sel-info]');
  const selStart = $<HTMLInputElement>('[data-sel-start]');
  const selEnd = $<HTMLInputElement>('[data-sel-end]');
  const pointSec = $('[data-point-sec]');
  const pointList = $('[data-point]');
  const simplifyInfo = $('[data-simplify-info]');
  const outlierInfo = $('[data-outlier-info]');
  const outlierNext = $<HTMLButtonElement>('[data-outlier-next]');
  /** Flat indices of the active track's distance outliers at the current threshold; ringed on the map. */
  let outliers: number[] = [];
  const mergeInfo = $('[data-merge-info]');
  const overlapBox = $('[data-overlap]');
  const exportBtn = $<HTMLButtonElement>('[data-export]');
  const exportInfo = $('[data-export-info]');
  const eachBox = $<HTMLInputElement>('[data-each]');
  const icons = $<HTMLTemplateElement>('[data-icons]').content;
  const icon = (name: string) => icons.querySelector(`.i-${name}`)!.cloneNode(true);
  const act = (name: string) => $<HTMLButtonElement>(`[data-act="${name}"]`);
  const radio = (name: string) => (root.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)?.value ?? '');
  const mapCtx = mapCanvas.getContext('2d')!;
  const profCtx = profCanvas.getContext('2d')!;
  let mode = new URLSearchParams(location.search).get('mode');

  let items: Item[] = [];
  let activeId = 0;
  let nextId = 1;
  const ticked = new Set<number>();
  /** Flat point range on the active track (a ≤ b). */
  let sel: { a: number; b: number } | null = null;
  /** Hovered point of the active track (map or profile). */
  let cursor: number | null = null;
  /** Selected point of the active track: edited by Delete, used by Split. */
  let mark: number | null = null;
  /** Point being dragged on the map (preview until pointerup). */
  let moving: { i: number; wx: number; wy: number } | null = null;
  let showPoints = false;
  let showHr = true;
  const undoStack: Snap[] = [];
  const redoStack: Snap[] = [];
  const view = { x: 0.5, y: 0.5, s: 512 };
  let W = 0;
  let H = 0;

  // Canvas colours from the theme's CSS variables (light-dark() resolved through a probe element).
  const probe = el('span', { hidden: true });
  root.append(probe);
  const readPalette = () => {
    const get = (v: string) => ((probe.style.color = `var(${v})`), getComputedStyle(probe).color);
    return { fg: get('--fg'), muted: get('--muted'), accent: get('--accent'), stage: get('--app-stage'), bar: get('--app-bar'), line: get('--app-line') };
  };
  let pal = readPalette();
  const repaint = () => ((pal = readPalette()), draw());
  new MutationObserver(repaint).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', repaint);

  const active = () => items.find((i) => i.id === activeId);
  const tickedItems = () => items.filter((i) => ticked.has(i.id));

  function notify(text: string, kind: 'info' | 'error' = 'info') {
    msg.hidden = !text;
    msg.dataset.kind = kind;
    msgText.textContent = text;
  }

  // ---------- History ----------
  const snap = (): Snap => ({ items: items.map((i) => ({ ...i })), activeId, ticked: [...ticked] });
  function restore(s: Snap) {
    cancelGesture();
    items = s.items.map((i) => ({ ...i }));
    activeId = s.activeId;
    ticked.clear();
    for (const id of s.ticked) ticked.add(id);
    sel = cursor = mark = null;
    refresh();
  }
  /** Run an undoable change. Tracks left without points are dropped. */
  function commit(fn: () => void, message = '') {
    cancelGesture();
    undoStack.push(snap());
    if (undoStack.length > 200) undoStack.shift();
    redoStack.length = 0;
    fn();
    const before = items.length;
    items = items.filter((i) => i.t.segs.length);
    if (!active()) activeId = items[0]?.id ?? 0;
    sel = cursor = mark = null;
    refresh();
    notify(message + (items.length < before ? ' A track with no points left was removed.' : ''));
  }
  function undo() {
    const s = undoStack.pop();
    if (!s) return;
    redoStack.push(snap());
    restore(s);
    notify('Undone.');
  }
  function redo() {
    const s = redoStack.pop();
    if (!s) return;
    undoStack.push(snap());
    restore(s);
    notify('Redone.');
  }

  // ---------- Loading ----------
  async function addFiles(files: File[]) {
    const added: Item[] = [];
    const errors: string[] = [];
    for (const f of files) {
      try {
        if (f.size > MAX_BYTES) throw new UserError('Larger than the 50 MB limit.');
        const g = parseGpx(await f.text());
        const tracks = g.tracks.filter((t) => t.segs.length);
        if (!tracks.length) throw new UserError('Contains no tracks or routes.');
        const base = g.name || f.name.replace(/\.[^.]*$/, '');
        tracks.forEach((t, k) =>
          added.push({
            id: nextId++,
            t: t.name ? t : { ...t, name: tracks.length > 1 ? `${base} ${k + 1}` : base },
            color: COLORS[(items.length + added.length) % COLORS.length],
            hidden: false,
            // File waypoints travel with the file's first track.
            wpts: k ? [] : g.wpts,
            ns: g.ns,
          }),
        );
      } catch (e) {
        if (!(e instanceof UserError)) console.error(e);
        errors.push(`${f.name}: ${e instanceof UserError ? e.message : 'Could not be read.'}`);
      }
    }
    if (added.length) {
      commit(() => {
        items.push(...added);
        activeId = added[0].id;
        if (mode === 'merge') for (const i of added) ticked.add(i.id);
      });
      fit();
    }
    if (errors.length) notify(errors.join('\n'), 'error');
  }

  // ---------- Map ----------
  const sx = (wx: number) => (wx - view.x) * view.s + W / 2;
  const sy = (wy: number) => (wy - view.y) * view.s + H / 2;
  const clampS = (s: number) => Math.min(MAX_S, Math.max(MIN_S, s));

  /** Set when fit() ran before the map had a size (e.g. a hidden hub frame); the next draw fits. */
  let pendingFit = false;
  function fit() {
    const vis = items.filter((i) => !i.hidden);
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const it of vis.length ? vis : items) {
      const d = info(it.t);
      for (let i = 0; i < d.wx.length; i++) {
        x0 = Math.min(x0, d.wx[i]);
        x1 = Math.max(x1, d.wx[i]);
        y0 = Math.min(y0, d.wy[i]);
        y1 = Math.max(y1, d.wy[i]);
      }
    }
    W = map.clientWidth;
    H = map.clientHeight;
    pendingFit = !W || !H;
    if (!(x0 <= x1) || !W || !H) return;
    view.s = clampS(Math.min(FIT_MAX_S, (W - 64) / (x1 - x0 || 1e-12), (H - 64) / (y1 - y0 || 1e-12)));
    view.x = (x0 + x1) / 2;
    view.y = (y0 + y1) / 2;
    draw();
  }

  function zoomAt(px: number, py: number, f: number) {
    const wx = view.x + (px - W / 2) / view.s;
    const wy = view.y + (py - H / 2) / view.s;
    view.s = clampS(view.s * f);
    view.x = wx - (px - W / 2) / view.s;
    view.y = wy - (py - H / 2) / view.s;
    draw();
  }

  function sizeCanvas(c: HTMLCanvasElement, ctx: CanvasRenderingContext2D, w: number, h: number) {
    const dpr = devicePixelRatio || 1;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
  }

  function drawMap() {
    W = map.clientWidth;
    H = map.clientHeight;
    const c = mapCtx;
    sizeCanvas(mapCanvas, c, W, H);
    if (!items.length || !W || !H) return;
    if (pendingFit) fit();

    // Graticule: degree lines at a step that keeps them ≥ 90 px apart.
    const degPx = view.s / 360;
    const step = [1e-4, 2e-4, 5e-4, 1e-3, 2e-3, 5e-3, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30].find((s) => s * degPx >= 90) ?? 45;
    c.strokeStyle = pal.fg;
    c.globalAlpha = 0.08;
    c.lineWidth = 1;
    c.beginPath();
    const lonL = lonOf(view.x - W / 2 / view.s);
    const lonR = lonOf(view.x + W / 2 / view.s);
    for (let lon = Math.ceil(lonL / step) * step, n = 0; lon <= lonR && n < 400; lon += step, n++) {
      const x = Math.round(sx(mx(lon))) + 0.5;
      c.moveTo(x, 0);
      c.lineTo(x, H);
    }
    const latB = latOf(view.y + H / 2 / view.s);
    const latT = latOf(view.y - H / 2 / view.s);
    for (let lat = Math.ceil(latB / step) * step, n = 0; lat <= latT && n < 400; lat += step, n++) {
      const y = Math.round(sy(my(lat))) + 0.5;
      c.moveTo(0, y);
      c.lineTo(W, y);
    }
    c.stroke();
    c.globalAlpha = 1;

    const a = active();
    const X = (d: Derived, i: number, act: boolean) => sx(act && moving?.i === i ? moving.wx : d.wx[i]);
    const Y = (d: Derived, i: number, act: boolean) => sy(act && moving?.i === i ? moving.wy : d.wy[i]);
    /** Polyline of points from..to, skipping points under half a pixel from the last drawn one. */
    const trace = (d: Derived, act: boolean, from = 0, to = d.pts.length - 1) => {
      c.beginPath();
      let lx = NaN;
      let ly = NaN;
      for (let i = from; i <= to; i++) {
        const x = X(d, i, act);
        const y = Y(d, i, act);
        if (i === from || d.brk[i]) c.moveTo(x, y);
        else if (Math.abs(x - lx) >= 0.5 || Math.abs(y - ly) >= 0.5 || i === to || d.brk[i + 1]) c.lineTo(x, y);
        else continue;
        lx = x;
        ly = y;
      }
    };
    c.lineJoin = 'round';
    c.lineCap = 'round';
    const vis = items.filter((i) => !i.hidden);
    for (const it of vis) {
      if (it === a) continue;
      trace(info(it.t), false);
      c.globalAlpha = 0.75;
      c.strokeStyle = it.color;
      c.lineWidth = 3;
      c.stroke();
      c.globalAlpha = 1;
    }
    const ad = a && !a.hidden ? info(a.t) : undefined;
    if (a && ad) {
      trace(ad, true);
      c.strokeStyle = pal.stage;
      c.lineWidth = 8;
      c.stroke();
      if (sel) {
        trace(ad, true, sel.a, sel.b);
        c.strokeStyle = pal.accent;
        c.globalAlpha = 0.4;
        c.lineWidth = 14;
        c.stroke();
        c.globalAlpha = 1;
        trace(ad, true);
      }
      c.strokeStyle = a.color;
      c.lineWidth = 4;
      c.stroke();
      if (showPoints) {
        c.fillStyle = pal.bar;
        c.strokeStyle = a.color;
        c.lineWidth = 1.5;
        let lx = NaN;
        let ly = NaN;
        for (let i = 0; i < ad.pts.length; i++) {
          const x = X(ad, i, true);
          const y = Y(ad, i, true);
          if (Math.hypot(x - lx, y - ly) < 5 || x < -5 || y < -5 || x > W + 5 || y > H + 5) continue;
          c.beginPath();
          c.arc(x, y, 3, 0, Math.PI * 2);
          c.fill();
          c.stroke();
          lx = x;
          ly = y;
        }
      }
    }
    const dot = (x: number, y: number, r: number, fill: string, ring = '#fff') => {
      c.beginPath();
      c.arc(x, y, r, 0, Math.PI * 2);
      c.fillStyle = fill;
      c.fill();
      c.lineWidth = 2;
      c.strokeStyle = ring;
      c.stroke();
    };
    for (const it of vis) {
      const d = info(it.t);
      const act = it === a;
      const n = d.pts.length - 1;
      dot(X(d, n, act), Y(d, n, act), act ? 6 : 4.5, END);
      dot(X(d, 0, act), Y(d, 0, act), act ? 6 : 4.5, START);
    }
    if (ad) {
      c.lineWidth = 2.5;
      c.strokeStyle = END;
      for (const i of outliers) {
        if (i >= ad.pts.length) continue;
        c.beginPath();
        c.arc(X(ad, i, true), Y(ad, i, true), 9, 0, Math.PI * 2);
        c.stroke();
      }
      const m = moving?.i ?? mark;
      if (m !== null && m < ad.pts.length) dot(X(ad, m, true), Y(ad, m, true), 6.5, pal.bar, pal.fg);
      if (cursor !== null && cursor < ad.pts.length) dot(X(ad, cursor, true), Y(ad, cursor, true), 5.5, pal.accent);
    }

    // Scale bar (bottom left) and north arrow (top right) stand in for a basemap.
    const mpp = (2 * Math.PI * 6371008.8 * Math.cos(latOf(view.y) * RAD)) / view.s;
    const len = nice(mpp * 120);
    const bw = len / mpp;
    const label = len >= 1000 ? `${len / 1000} km` : `${len} m`;
    c.font = '600 11px system-ui, sans-serif';
    c.fillStyle = pal.bar;
    c.globalAlpha = 0.85;
    c.fillRect(8, H - 30, bw + 16 + c.measureText(label).width + 8, 22);
    c.globalAlpha = 1;
    c.strokeStyle = pal.fg;
    c.lineWidth = 1.5;
    c.beginPath();
    c.moveTo(16, H - 22);
    c.lineTo(16, H - 15);
    c.lineTo(16 + bw, H - 15);
    c.lineTo(16 + bw, H - 22);
    c.stroke();
    c.fillStyle = pal.fg;
    c.textBaseline = 'middle';
    c.fillText(label, 24 + bw, H - 19);
    c.save();
    c.translate(W - 26, 30);
    c.fillStyle = pal.bar;
    c.globalAlpha = 0.85;
    c.beginPath();
    c.arc(0, 0, 16, 0, Math.PI * 2);
    c.fill();
    c.globalAlpha = 1;
    c.beginPath();
    c.moveTo(0, -11);
    c.lineTo(5, 3);
    c.lineTo(0, 0);
    c.lineTo(-5, 3);
    c.closePath();
    c.fillStyle = pal.accent;
    c.fill();
    c.fillStyle = pal.fg;
    c.textAlign = 'center';
    c.font = '700 8px system-ui, sans-serif';
    c.fillText('N', 0, 9);
    c.restore();

    // Tooltip for the hovered (or dragged) point.
    const ti = moving?.i ?? cursor;
    if (ad && ti !== null && ti < ad.pts.length) {
      const x = X(ad, ti, true);
      const y = Y(ad, ti, true);
      if (x >= 0 && y >= 0 && x <= W && y <= H) {
        tip.textContent = tipLines(ad, ti).join('\n');
        tip.hidden = false;
        const left = x + 14 + tip.offsetWidth > W ? x - 14 - tip.offsetWidth : x + 14;
        const top = Math.min(H - tip.offsetHeight - 4, Math.max(4, y - tip.offsetHeight - 10));
        tip.style.translate = `${Math.max(4, left)}px ${top}px`;
        return;
      }
    }
    tip.hidden = true;
  }

  function nearest(d: Derived, px: number, py: number, max: number): number {
    let best = -1;
    let bd = max * max;
    for (let i = 0; i < d.wx.length; i++) {
      const dx = sx(d.wx[i]) - px;
      const dy = sy(d.wy[i]) - py;
      const dd = dx * dx + dy * dy;
      if (dd <= bd) (bd = dd), (best = i);
    }
    return best;
  }

  /** Closest spot on a line of the track: index of the segment start and the world position on it. */
  function nearestLine(d: Derived, px: number, py: number, max: number) {
    let best: { i: number; wx: number; wy: number } | null = null;
    let bd = max;
    for (let i = 0; i + 1 < d.wx.length; i++) {
      if (d.brk[i + 1]) continue;
      const ax = sx(d.wx[i]);
      const ay = sy(d.wy[i]);
      const dx = sx(d.wx[i + 1]) - ax;
      const dy = sy(d.wy[i + 1]) - ay;
      const len2 = dx * dx + dy * dy;
      const u = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
      const dist = Math.hypot(ax + u * dx - px, ay + u * dy - py);
      if (dist < bd) {
        bd = dist;
        best = { i, wx: d.wx[i] + u * (d.wx[i + 1] - d.wx[i]), wy: d.wy[i] + u * (d.wy[i + 1] - d.wy[i]) };
      }
    }
    return best;
  }

  const local = (e: { clientX: number; clientY: number }, box: Element) => {
    const r = box.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const ptrs = new Map<number, { x: number; y: number }>();
  type Gesture =
    | { kind: 'pan'; x: number; y: number; vx: number; vy: number; moved: boolean }
    | { kind: 'point'; i: number; x: number; y: number; moved: boolean }
    | { kind: 'pinch'; d: number; s: number; wx: number; wy: number };
  let gesture: Gesture | null = null;
  function cancelGesture() {
    gesture = moving = pdrag = null;
    for (const id of ptrs.keys()) if (map.hasPointerCapture(id)) map.releasePointerCapture(id);
    ptrs.clear();
  }
  const pinchState = () => {
    const [p, q] = [...ptrs.values()];
    const cx = (p.x + q.x) / 2;
    const cy = (p.y + q.y) / 2;
    return { d: Math.hypot(p.x - q.x, p.y - q.y) || 1, cx, cy };
  };

  map.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    map.focus({ preventScroll: true });
    map.setPointerCapture(e.pointerId);
    const p = local(e, map);
    ptrs.set(e.pointerId, p);
    if (ptrs.size === 2) {
      moving = null;
      const ps = pinchState();
      gesture = { kind: 'pinch', d: ps.d, s: view.s, wx: view.x + (ps.cx - W / 2) / view.s, wy: view.y + (ps.cy - H / 2) / view.s };
      return;
    }
    if (ptrs.size > 2) return;
    const a = active();
    const hit = a && !a.hidden && showPoints ? nearest(info(a.t), p.x, p.y, e.pointerType === 'mouse' ? 9 : 16) : -1;
    if (hit >= 0) {
      mark = hit;
      gesture = { kind: 'point', i: hit, x: p.x, y: p.y, moved: false };
      renderInspector();
      draw();
    } else gesture = { kind: 'pan', x: p.x, y: p.y, vx: view.x, vy: view.y, moved: false };
  });
  map.addEventListener('pointermove', (e) => {
    const p = local(e, map);
    if (ptrs.has(e.pointerId)) ptrs.set(e.pointerId, p);
    if (!gesture) return hover(p.x, p.y);
    if (gesture.kind === 'pinch') {
      if (ptrs.size < 2) return;
      const ps = pinchState();
      view.s = clampS((gesture.s * ps.d) / gesture.d);
      view.x = gesture.wx - (ps.cx - W / 2) / view.s;
      view.y = gesture.wy - (ps.cy - H / 2) / view.s;
      return draw();
    }
    if (Math.hypot(p.x - gesture.x, p.y - gesture.y) > 3) gesture.moved = true;
    if (!gesture.moved) return;
    if (gesture.kind === 'pan') {
      view.x = gesture.vx - (p.x - gesture.x) / view.s;
      view.y = gesture.vy - (p.y - gesture.y) / view.s;
    } else moving = { i: gesture.i, wx: view.x + (p.x - W / 2) / view.s, wy: view.y + (p.y - H / 2) / view.s };
    draw();
  });
  const endPointer = (e: PointerEvent) => {
    ptrs.delete(e.pointerId);
    const g = gesture;
    if (!g) return;
    if (g.kind === 'pinch') {
      // Lifting one finger ends the pinch without turning into a pan.
      if (ptrs.size < 2) gesture = null;
      return;
    }
    gesture = null;
    const a = active();
    if (g.kind === 'point' && moving && a && e.type === 'pointerup') {
      const { i, wx, wy } = moving;
      moving = null;
      commit(() => (a.t = movePoint(a.t, i, latOf(wy), lonOf(wx))), 'Point moved.');
      mark = i;
      renderInspector();
      draw();
      return;
    }
    moving = null;
    if (g.kind === 'pan' && !g.moved && e.type === 'pointerup') click(local(e, map));
    else draw();
  };
  map.addEventListener('pointerup', endPointer);
  map.addEventListener('pointercancel', endPointer);
  map.addEventListener('pointerleave', () => {
    if (gesture) return;
    cursor = null;
    map.removeAttribute('data-hover');
    draw();
  });

  function hover(x: number, y: number) {
    const a = active();
    const i = a && !a.hidden ? nearest(info(a.t), x, y, 14) : -1;
    cursor = i >= 0 ? i : null;
    map.toggleAttribute('data-hover', i >= 0 || items.some((it) => it !== a && !it.hidden && nearest(info(it.t), x, y, 8) >= 0));
    draw();
  }

  function click(p: { x: number; y: number }) {
    const a = active();
    const i = a && !a.hidden ? nearest(info(a.t), p.x, p.y, 10) : -1;
    if (i >= 0) {
      mark = i;
      sel = null;
    } else {
      const other = items.find((it) => it !== a && !it.hidden && nearest(info(it.t), p.x, p.y, 8) >= 0);
      if (other) return setActive(other.id);
      mark = null;
    }
    renderInspector();
    draw();
  }

  map.addEventListener('dblclick', (e) => {
    const p = local(e, map);
    const a = active();
    const hit = a && !a.hidden && showPoints ? nearestLine(info(a.t), p.x, p.y, 10) : null;
    if (a && hit) {
      commit(() => (a.t = insertPoint(a.t, hit.i, latOf(hit.wy), lonOf(hit.wx))), 'Point inserted.');
      mark = hit.i + 1;
      renderInspector();
      draw();
    } else zoomAt(p.x, p.y, 2);
  });
  map.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const p = local(e, map);
      zoomAt(p.x, p.y, Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0025)));
    },
    { passive: false },
  );
  map.addEventListener('keydown', (e) => {
    const pan = { ArrowLeft: [-60, 0], ArrowRight: [60, 0], ArrowUp: [0, -60], ArrowDown: [0, 60] }[e.key];
    if (pan && !e.altKey && !e.ctrlKey && !e.metaKey) {
      view.x += pan[0] / view.s;
      view.y += pan[1] / view.s;
    } else if (e.key === '+' || e.key === '=') zoomAt(W / 2, H / 2, 1.5);
    else if (e.key === '-' || e.key === '_') zoomAt(W / 2, H / 2, 1 / 1.5);
    else return;
    e.preventDefault();
    draw();
  });

  // ---------- Profile ----------
  let PW = 0;
  let PH = 0;
  const profX = (d: Derived, i: number) => {
    const total = d.dist[d.dist.length - 1];
    const f = total > 0 ? d.dist[i] / total : d.pts.length > 1 ? i / (d.pts.length - 1) : 0;
    return PL + f * (PW - PL - PR);
  };
  const profIndex = (d: Derived, x: number) => {
    const f = Math.max(0, Math.min(1, (x - PL) / (PW - PL - PR)));
    const total = d.dist[d.dist.length - 1];
    return total > 0 ? indexAt(d, f * total) : Math.round(f * (d.pts.length - 1));
  };

  function drawProfile() {
    PW = prof.clientWidth;
    PH = prof.clientHeight;
    const c = profCtx;
    sizeCanvas(profCanvas, c, PW, PH);
    const a = active();
    profRead.textContent = '';
    if (!a || !PW || !PH) return;
    const d = info(a.t);
    const n = d.pts.length;
    const bottom = PH - PB;
    const plotH = bottom - PT;
    c.font = '11px system-ui, sans-serif';
    c.textBaseline = 'middle';

    // Distance axis.
    const total = d.dist[n - 1];
    c.fillStyle = pal.muted;
    c.strokeStyle = pal.fg;
    c.lineWidth = 1;
    c.textAlign = 'center';
    if (total > 0) {
      const stepM = nice(total / Math.max(1, Math.floor((PW - PL - PR) / 90)));
      for (let k = 0; k * stepM <= total + 1e-6; k++) {
        const m = k * stepM;
        const x = PL + (m / total) * (PW - PL - PR);
        c.fillText(total >= 1000 ? `${+(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`, x, PH - 9);
      }
    }

    // Selection band with edge grips.
    if (sel) {
      const x0 = profX(d, sel.a);
      const x1 = profX(d, sel.b);
      c.fillStyle = pal.accent;
      c.globalAlpha = 0.14;
      c.fillRect(x0, PT, Math.max(1, x1 - x0), plotH);
      c.globalAlpha = 1;
      for (const x of [x0, x1]) {
        c.fillRect(x - 1, PT, 2, plotH);
        c.fillRect(x - 3, PT + plotH / 2 - 10, 6, 20);
      }
    }

    // Elevation: gridlines, labelled on the left, filled area.
    let yEle: ((v: number) => number) | undefined;
    if (d.hasEle) {
      const lo0 = d.stats.minEle!;
      const hi0 = d.stats.maxEle!;
      const step = nice(Math.max(1, (hi0 - lo0) / 3));
      const lo = Math.floor(lo0 / step) * step;
      const hi = Math.max(lo + step, Math.ceil(hi0 / step) * step);
      yEle = (v) => bottom - ((v - lo) / (hi - lo)) * plotH;
      c.textAlign = 'right';
      c.beginPath();
      for (let v = lo; v <= hi + 1e-6; v += step) {
        const y = Math.round(yEle(v)) + 0.5;
        c.moveTo(PL, y);
        c.lineTo(PW - PR, y);
        c.fillStyle = pal.muted;
        c.fillText(`${Math.round(v)} m`, PL - 6, y);
      }
      c.globalAlpha = 0.08;
      c.stroke();
      c.globalAlpha = 1;
      c.beginPath();
      let lx = -Infinity;
      let first = true;
      for (let i = 0; i < n; i++) {
        const e = d.pts[i].ele;
        if (e === undefined) continue;
        const x = profX(d, i);
        if (x - lx < 0.5 && i !== n - 1) continue;
        if (first) c.moveTo(x, bottom), (first = false);
        c.lineTo(x, yEle(e));
        lx = x;
      }
      c.lineTo(lx, bottom);
      c.closePath();
      c.fillStyle = a.color;
      c.globalAlpha = 0.18;
      c.fill();
      c.globalAlpha = 1;
      c.beginPath();
      lx = -Infinity;
      first = true;
      for (let i = 0; i < n; i++) {
        const e = d.pts[i].ele;
        if (e === undefined) continue;
        const x = profX(d, i);
        if (x - lx < 0.5 && i !== n - 1) continue;
        if (first) c.moveTo(x, yEle(e)), (first = false);
        else c.lineTo(x, yEle(e));
        lx = x;
      }
      c.strokeStyle = a.color;
      c.lineWidth = 2;
      c.stroke();
    } else {
      c.fillStyle = pal.muted;
      c.textAlign = 'center';
      c.fillText('No elevation data', (PL + PW - PR) / 2, PT + plotH / 2);
    }

    // Heart rate on its own scale, labelled on the right.
    let yHr: ((v: number) => number) | undefined;
    if (d.hasHr && showHr) {
      const lo = Math.floor(Math.max(0, d.minHr - 5) / 10) * 10;
      const hi = Math.ceil((d.stats.maxHr! + 5) / 10) * 10;
      yHr = (v) => bottom - ((v - lo) / (hi - lo || 1)) * plotH;
      c.fillStyle = HR;
      c.textAlign = 'left';
      c.fillText(`${hi}`, PW - PR + 6, PT + 4);
      c.fillText(`${lo}`, PW - PR + 6, bottom - 4);
      c.beginPath();
      let lx = -Infinity;
      let first = true;
      for (let i = 0; i < n; i++) {
        const v = d.pts[i].hr;
        if (v === undefined) continue;
        const x = profX(d, i);
        if (x - lx < 1 && i !== n - 1) continue;
        if (first) c.moveTo(x, yHr(v)), (first = false);
        else c.lineTo(x, yHr(v));
        lx = x;
      }
      c.strokeStyle = HR;
      c.globalAlpha = 0.8;
      c.lineWidth = 1.25;
      c.stroke();
      c.globalAlpha = 1;
    }

    // Selected point (dashed) and hover crosshair.
    if (mark !== null && mark < n) {
      const x = Math.round(profX(d, mark)) + 0.5;
      c.setLineDash([4, 3]);
      c.strokeStyle = pal.fg;
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(x, PT);
      c.lineTo(x, bottom);
      c.stroke();
      c.setLineDash([]);
    }
    const ci = moving?.i ?? cursor;
    if (ci !== null && ci < n) {
      const p = d.pts[ci];
      const x = Math.round(profX(d, ci)) + 0.5;
      c.strokeStyle = pal.accent;
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(x, PT);
      c.lineTo(x, bottom);
      c.stroke();
      for (const [v, y, col] of [
        [p.ele, yEle, pal.accent],
        [p.hr, yHr, HR],
      ] as const) {
        if (v === undefined || !y) continue;
        c.beginPath();
        c.arc(x, y(v), 4, 0, Math.PI * 2);
        c.fillStyle = col;
        c.fill();
      }
      profRead.textContent = tipLines(d, ci).join(' · ');
    }
  }

  let pdrag: { edge: 'a' | 'b' | 'new'; anchor: number; x: number; moved: boolean } | null = null;
  prof.addEventListener('pointerdown', (e) => {
    const a = active();
    if (!a || (e.pointerType === 'mouse' && e.button !== 0)) return;
    prof.setPointerCapture(e.pointerId);
    const d = info(a.t);
    const { x } = local(e, prof);
    const i = profIndex(d, x);
    const grab = e.pointerType === 'mouse' ? 6 : 14;
    if (sel && Math.abs(x - profX(d, sel.a)) <= grab) pdrag = { edge: 'a', anchor: sel.b, x, moved: true };
    else if (sel && Math.abs(x - profX(d, sel.b)) <= grab) pdrag = { edge: 'b', anchor: sel.a, x, moved: true };
    else pdrag = { edge: 'new', anchor: i, x, moved: false };
  });
  prof.addEventListener('pointermove', (e) => {
    const a = active();
    if (!a) return;
    const d = info(a.t);
    const { x } = local(e, prof);
    const i = profIndex(d, x);
    cursor = i;
    if (pdrag) {
      if (Math.abs(x - pdrag.x) > 3) pdrag.moved = true;
      if (pdrag.moved) {
        sel = { a: Math.min(pdrag.anchor, i), b: Math.max(pdrag.anchor, i) };
        renderSelection();
      }
    }
    draw();
  });
  const endProf = (e: PointerEvent) => {
    const a = active();
    const g = pdrag;
    pdrag = null;
    if (!a || !g) return;
    if (!g.moved && e.type === 'pointerup') {
      // A click places the cursor (used by Split) and clears the range.
      mark = g.anchor;
      sel = null;
    } else if (sel && sel.a === sel.b) sel = null;
    renderInspector();
    draw();
  };
  prof.addEventListener('pointerup', endProf);
  prof.addEventListener('pointercancel', endProf);
  prof.addEventListener('pointerleave', () => {
    if (pdrag) return;
    cursor = null;
    draw();
  });

  let frame = 0;
  function draw() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      drawMap();
      if (root.hasAttribute('data-profile')) drawProfile();
    });
  }
  new ResizeObserver(draw).observe(map);
  new ResizeObserver(draw).observe(prof);

  // ---------- Track list ----------
  function setActive(id: number) {
    if (id === activeId) return;
    cancelGesture();
    activeId = id;
    sel = cursor = mark = null;
    refresh();
  }

  function renderList() {
    list.replaceChildren(
      ...items.map((it) => {
        const d = info(it.t);
        const s = d.stats;
        const name = it.t.name || 'Untitled';
        const meta = [km(s.distance), s.elapsed !== undefined ? dur(s.elapsed) : '', `${s.points.toLocaleString()} pts`].filter(Boolean);
        const li = el(
          'li',
          { class: 'gx-item' },
          el('button', { type: 'button', className: 'gx-tool gx-grip', title: 'Drag to reorder (Alt+↑/↓)', ariaLabel: `Reorder ${name}` }, icon('grip')),
          el('input', { type: 'checkbox', checked: ticked.has(it.id), ariaLabel: `Select ${name} for merge or export` }),
          el('input', { type: 'color', value: it.color, className: 'gx-swatch', title: 'Track colour', ariaLabel: `Colour of ${name}` }),
          el(
            'button',
            { type: 'button', className: 'gx-item-main', title: 'Show this track · double-click to rename' },
            el('span', { className: 'gx-item-name' }, name),
            el('span', { className: 'gx-item-meta' }, s.start !== undefined ? dayFmt.format(s.start) : ''),
            el('span', { className: 'gx-item-meta' }, meta.join(' · ')),
          ),
          el(
            'button',
            { type: 'button', className: 'gx-tool gx-vis', title: it.hidden ? 'Show on map' : 'Hide on map', ariaLabel: `${it.hidden ? 'Show' : 'Hide'} ${name}` },
            icon(it.hidden ? 'eye-off' : 'eye'),
          ),
          el('button', { type: 'button', className: 'gx-tool gx-del', title: 'Delete track', ariaLabel: `Delete ${name}` }, icon('trash')),
        );
        li.dataset.id = String(it.id);
        if (it.id === activeId) li.setAttribute('aria-current', 'true');
        li.toggleAttribute('data-hidden', it.hidden);
        return li;
      }),
    );
  }

  const itemOf = (node: EventTarget | null) => {
    const li = (node as Element | null)?.closest<HTMLElement>('.gx-item');
    return li ? items.find((i) => i.id === Number(li.dataset.id)) : undefined;
  };
  list.addEventListener('click', (e) => {
    const it = itemOf(e.target);
    const btn = (e.target as Element).closest('button');
    if (!it || !btn) return;
    if (btn.classList.contains('gx-vis')) {
      it.hidden = !it.hidden;
      renderList();
      list.querySelector<HTMLElement>(`[data-id="${it.id}"] .gx-vis`)?.focus();
      draw();
    } else if (btn.classList.contains('gx-del')) {
      if (confirm(`Delete “${it.t.name || 'Untitled'}”? You can undo this.`)) {
        commit(() => {
          items = items.filter((i) => i !== it);
          ticked.delete(it.id);
        }, `Deleted “${it.t.name}”.`);
      }
    } else if (btn.classList.contains('gx-item-main')) setActive(it.id);
  });
  list.addEventListener('dblclick', (e) => {
    if (!(e.target as Element).closest('.gx-item-main')) return;
    nameInput.focus();
    nameInput.select();
  });
  list.addEventListener('change', (e) => {
    const t = e.target as HTMLInputElement;
    const it = itemOf(t);
    if (!it) return;
    if (t.type === 'checkbox') {
      if (t.checked) ticked.add(it.id);
      else ticked.delete(it.id);
      renderInspector();
    }
  });
  list.addEventListener('input', (e) => {
    const t = e.target as HTMLInputElement;
    const it = itemOf(t);
    if (it && t.type === 'color') {
      it.color = t.value;
      draw();
    }
  });
  function moveItem(it: Item, to: number) {
    const from = items.indexOf(it);
    if (to === from || to < 0 || to >= items.length) return;
    commit(() => {
      items.splice(from, 1);
      items.splice(to, 0, it);
    }, 'Order changed.');
  }
  list.addEventListener('keydown', (e) => {
    const it = itemOf(e.target);
    if (!it || !e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    moveItem(it, items.indexOf(it) + (e.key === 'ArrowUp' ? -1 : 1));
    list.querySelector<HTMLElement>(`[data-id="${it.id}"] .gx-grip`)?.focus();
  });
  list.addEventListener('pointerdown', (e) => {
    const grip = (e.target as Element).closest<HTMLElement>('.gx-grip');
    const it = itemOf(grip);
    if (!grip || !it || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    const li = grip.closest<HTMLElement>('.gx-item')!;
    li.toggleAttribute('data-lifted', true);
    root.classList.add('gx-dragging');
    let target: { li: HTMLElement; before: boolean } | null = null;
    const move = (ev: PointerEvent) => {
      target?.li.removeAttribute('data-drop');
      const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>('.gx-item');
      target = null;
      if (!over || over === li || !list.contains(over)) return;
      const r = over.getBoundingClientRect();
      target = { li: over, before: ev.clientY < r.top + r.height / 2 };
      over.dataset.drop = target.before ? 'before' : 'after';
    };
    const up = () => {
      grip.removeEventListener('pointermove', move);
      li.removeAttribute('data-lifted');
      root.classList.remove('gx-dragging');
      target?.li.removeAttribute('data-drop');
      const over = itemOf(target?.li ?? null);
      if (!target || !over) return;
      const rest = items.filter((i) => i !== it);
      moveItem(it, rest.indexOf(over) + (target.before ? 0 : 1));
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up, { once: true });
    grip.addEventListener('pointercancel', up, { once: true });
  });
  $('[data-tick-all]').addEventListener('click', () => {
    const all = items.length > 0 && items.every((i) => ticked.has(i.id));
    for (const i of items) {
      if (all) ticked.delete(i.id);
      else ticked.add(i.id);
    }
    renderList();
    renderInspector();
  });

  // ---------- Inspector ----------
  function dl(box: HTMLElement, rows: [string, string][]) {
    box.replaceChildren(...rows.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)]));
  }

  function renderSelection() {
    const a = active();
    const d = a && info(a.t);
    act('trim').disabled = !sel;
    act('clear').disabled = !sel && mark === null;
    const at = mark ?? sel?.a;
    act('split').disabled = !d || at === undefined || at <= 0 || at >= d.pts.length - 1;
    act('cut').disabled = !d || !sel || (sel.a === 0 && sel.b === d.pts.length - 1);
    if (!d || !sel) {
      selInfo.textContent = 'Drag on the profile to select a range, or enter start and end. Click the profile or map to place the cursor for Split.';
      if (document.activeElement !== selStart) selStart.value = '';
      if (document.activeElement !== selEnd) selEnd.value = '';
      return;
    }
    const p = d.pts;
    const t0 = p[sel.a].time;
    const t1 = p[sel.b].time;
    selInfo.textContent = [
      `${(sel.b - sel.a + 1).toLocaleString()} points`,
      km(d.dist[sel.b] - d.dist[sel.a]),
      t0 !== undefined && t1 !== undefined ? dur(t1 - t0) : '',
    ]
      .filter(Boolean)
      .join(' · ');
    if (document.activeElement !== selStart) selStart.value = (d.dist[sel.a] / 1000).toFixed(2);
    if (document.activeElement !== selEnd) selEnd.value = (d.dist[sel.b] / 1000).toFixed(2);
  }

  let simplifyTimer = 0;
  function renderSimplify() {
    clearTimeout(simplifyTimer);
    const a = active();
    if (!a) return void (simplifyInfo.textContent = '');
    simplifyTimer = window.setTimeout(() => {
      const tol = Number($<HTMLFormElement>('[data-clean="simplify"]').tol.value);
      if (!(tol > 0)) return void (simplifyInfo.textContent = '');
      const n = count(a.t);
      simplifyInfo.textContent = `Keeps ${count(simplify(a.t, tol)).toLocaleString()} of ${n.toLocaleString()} points.`;
    }, 120);
  }

  let outlierTimer = 0;
  let outlierTrack: Track | undefined;
  let outlierDist = NaN;
  let outlierRun = NaN;
  const outlierForm = $<HTMLFormElement>('[data-clean="outliers"]');
  /** First flat index of each group of consecutive outliers. */
  const outlierStarts = () => outliers.filter((k, j) => outliers[j - 1] !== k - 1);
  function renderOutliers() {
    const t = active()?.t;
    const dist = Number(outlierForm.dist.value);
    const run = Number(outlierForm.run.value);
    if (t === outlierTrack && dist === outlierDist && run === outlierRun) {
      outlierNext.disabled = !outliers.length;
      return;
    }
    outlierTrack = t;
    outlierDist = dist;
    outlierRun = run;
    clearTimeout(outlierTimer);
    outliers = [];
    outlierNext.disabled = true;
    outlierInfo.textContent = '';
    draw();
    outlierTimer = window.setTimeout(() => {
      outliers = t && dist > 0 && run >= 1 ? findOutliers(t, dist, run) : [];
      const groups = outlierStarts().length;
      const n = outliers.length;
      outlierInfo.textContent = !t
        ? ''
        : !n
          ? 'None found with these settings.'
          : `${n.toLocaleString()} ${n === 1 ? 'point' : 'points'}${groups < n ? ` in ${groups.toLocaleString()} ${groups === 1 ? 'group' : 'groups'}` : ''}, ringed in red on the map.`;
      outlierNext.disabled = !n;
      draw();
    }, 120);
  }
  // Steps through the outlier groups: selects each group's first point (Point panel shows it) and centres the map on it.
  outlierNext.addEventListener('click', () => {
    const a = active();
    const starts = outlierStarts();
    if (!a || a.t !== outlierTrack || !starts.length) return;
    const i = starts.find((k) => mark === null || k > mark) ?? starts[0];
    const d = info(a.t);
    if (i < 0 || i >= d.pts.length) return;
    mark = i;
    view.x = d.wx[i];
    view.y = d.wy[i];
    renderInspector();
    draw();
  });

  function renderInspector() {
    const a = active();
    const d = a && info(a.t);
    if (document.activeElement !== nameInput) nameInput.value = a?.t.name ?? '';
    if (document.activeElement !== typeInput) typeInput.value = a?.t.type ?? '';
    if (d && a) {
      const s = d.stats;
      const foot = /run|walk|hik|trek|foot/i.test(a.t.type);
      const none = '—';
      dl(statsList, [
        ['Distance', km(s.distance)],
        ['Moving time', s.moving !== undefined ? dur(s.moving) : none],
        ['Elapsed time', s.elapsed !== undefined ? dur(s.elapsed) : none],
        ['Ascent', s.ascent !== undefined ? `${Math.round(s.ascent)} m` : none],
        ['Descent', s.descent !== undefined ? `${Math.round(s.descent)} m` : none],
        foot
          ? ['Avg pace', s.avgSpeed ? pace(s.avgSpeed) : none]
          : ['Avg speed', s.avgSpeed ? `${(s.avgSpeed * 3.6).toFixed(1)} km/h` : none],
        foot
          ? ['Best pace', s.maxSpeed ? pace(s.maxSpeed) : none]
          : ['Max speed', s.maxSpeed ? `${(s.maxSpeed * 3.6).toFixed(1)} km/h` : none],
        ...(d.hasHr
          ? ([
              ['Avg heart rate', `${Math.round(s.avgHr!)} bpm`],
              ['Max heart rate', `${Math.round(s.maxHr!)} bpm`],
            ] as [string, string][])
          : []),
        ['Points', s.points.toLocaleString()],
        ['Start', s.start !== undefined ? dateFmt.format(s.start) : none],
      ]);
      const startForm = $<HTMLFormElement>('[data-clean="start"]');
      const [date, time] = s.start !== undefined ? toLocalInput(s.start).split('T') : ['', ''];
      if (!startForm.contains(document.activeElement)) [startForm.startDate.value, startForm.startTime.value] = [date, time];
    }
    toggles.hr.hidden = !d?.hasHr;
    renderSelection();

    const pi = mark;
    pointSec.hidden = !d || pi === null || pi >= d.pts.length;
    if (d && pi !== null && !pointSec.hidden) {
      const p = d.pts[pi];
      dl(pointList, [
        ['Point', `${(pi + 1).toLocaleString()} of ${d.pts.length.toLocaleString()}`],
        ['Latitude', p.lat.toFixed(6)],
        ['Longitude', p.lon.toFixed(6)],
        ['Elevation', p.ele !== undefined ? `${p.ele} m` : '—'],
        ['Time', p.time !== undefined ? dateFmt.format(p.time) + ` (${timeFmt.format(p.time)})` : '—'],
        ['Distance', km(d.dist[pi])],
        ...(p.hr !== undefined ? ([['Heart rate', `${p.hr} bpm`]] as [string, string][]) : []),
        ...(p.cad !== undefined ? ([['Cadence', String(p.cad)]] as [string, string][]) : []),
      ]);
    }

    for (const b of root.querySelectorAll<HTMLButtonElement>('[data-clean] button')) b.disabled = !a;
    renderSimplify();
    renderOutliers();

    const tk = tickedItems();
    mergeInfo.textContent =
      tk.length < 2 ? 'Tick two or more tracks in the list to merge them into one track, or to combine them into one file.' : `${tk.length} tracks selected.`;
    act('merge').disabled = tk.length < 2;
    act('combine').disabled = tk.length < 2;
    const clash = tk.length < 2 ? [] : overlaps(tk.map((i) => i.t));
    overlapBox.hidden = !clash.length;
    overlapBox.textContent = clash.length
      ? `Overlapping times: ${clash.map(([x, y]) => `“${x.name}” and “${y.name}”`).join(', ')}. A merged track will jump back in time; combining into one file keeps them apart.`
      : '';

    const out = exportList();
    exportBtn.disabled = !out.length;
    exportInfo.textContent = out.length
      ? `${out.length} ${out.length === 1 ? 'track' : 'tracks'} · ${out.reduce((n, i) => n + count(i.t), 0).toLocaleString()} points` +
        (out.length > 1 && !eachBox.checked ? ' · one file' : '')
      : radio('gx-scope') === 'ticked' && items.length
        ? 'Tick tracks in the list to export them.'
        : '';
  }

  function refresh() {
    root.toggleAttribute('data-empty', !items.length);
    undoBtn.disabled = !undoStack.length;
    redoBtn.disabled = !redoStack.length;
    fitBtn.disabled = closeAll.disabled = !items.length;
    renderList();
    renderInspector();
    draw();
  }

  // ---------- Edits ----------
  const selAction: Record<string, () => void> = {
    trim: () => {
      const a = active();
      const s = sel;
      if (a && s) commit(() => (a.t = trim(a.t, s.a, s.b)), `Trimmed to ${(s.b - s.a + 1).toLocaleString()} points.`);
    },
    cut: () => {
      const a = active();
      const s = sel;
      if (a && s) commit(() => (a.t = cut(a.t, s.a, s.b, radio('gx-join') === 'join')), `Deleted ${(s.b - s.a + 1).toLocaleString()} points.`);
    },
    split: () => {
      const a = active();
      const at = mark ?? sel?.a;
      if (!a || at === undefined) return;
      const [one, two] = split(a.t, at);
      const it: Item = { id: nextId++, t: two, color: COLORS[(items.length + 1) % COLORS.length], hidden: false, wpts: [], ns: a.ns };
      commit(() => {
        a.t = one;
        items.splice(items.indexOf(a) + 1, 0, it);
      }, `Split into “${one.name}” and “${two.name}”.`);
    },
    clear: () => {
      sel = mark = null;
      renderInspector();
      draw();
    },
    'delete-point': () => deleteMark(),
    merge: () => {
      const tk = tickedItems();
      if (tk.length < 2) return;
      const t = merge(
        tk.map((i) => i.t),
        radio('gx-order') === 'time',
        radio('gx-segs') === 'one',
      );
      const it: Item = { id: nextId++, t, color: tk[0].color, hidden: false, wpts: tk.flatMap((i) => i.wpts), ns: Object.assign({}, ...tk.map((i) => i.ns)) };
      commit(() => {
        items.splice(items.indexOf(tk[0]), 1, it);
        items = items.filter((i) => !ticked.has(i.id));
        ticked.clear();
        activeId = it.id;
      }, `Merged ${tk.length} tracks into “${t.name || 'Untitled'}”.`);
    },
    combine: () => exportItems(tickedItems(), false),
  };
  for (const [k, fn] of Object.entries(selAction)) act(k).addEventListener('click', fn);

  function deleteMark() {
    const a = active();
    const i = mark;
    if (!a || i === null) return;
    commit(() => (a.t = deletePoint(a.t, i)), 'Point deleted.');
    const n = count(a.t);
    if (n) mark = Math.min(i, n - 1);
    renderInspector();
    draw();
  }

  selStart.addEventListener('change', setSelFromInputs);
  selEnd.addEventListener('change', setSelFromInputs);
  function setSelFromInputs() {
    const a = active();
    const s = parseFloat(selStart.value);
    const e = parseFloat(selEnd.value);
    if (!a || !Number.isFinite(s) || !Number.isFinite(e)) return;
    const d = info(a.t);
    const i = indexAt(d, Math.min(s, e) * 1000);
    const j = indexAt(d, Math.max(s, e) * 1000);
    sel = i < j ? { a: i, b: j } : null;
    renderSelection();
    draw();
  }

  nameInput.addEventListener('change', () => {
    const a = active();
    const v = nameInput.value.trim();
    if (a && v !== a.t.name) commit(() => (a.t = { ...a.t, name: v }), 'Renamed.');
  });
  typeInput.addEventListener('change', () => {
    const a = active();
    const v = typeInput.value.trim();
    if (a && v !== a.t.type) commit(() => (a.t = { ...a.t, type: v }), v ? `Activity type set to ${v}.` : 'Activity type removed.');
  });

  for (const form of root.querySelectorAll<HTMLFormElement>('[data-clean]')) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const a = active();
      if (!a) return;
      const v = (name: string) => Number((form.elements.namedItem(name) as HTMLInputElement).value);
      const s = info(a.t).stats;
      const kind = form.dataset.clean!;
      if (['pauses', 'spikes', 'shift', 'start'].includes(kind) && s.start === undefined) return notify('This track has no timestamps.', 'error');
      const n = count(a.t);
      let next: Track;
      let message: string;
      const removed = (t: Track) => (n - count(t)).toLocaleString();
      switch (kind) {
        case 'pauses': {
          const close = (form.elements.namedItem('close') as HTMLInputElement).checked;
          next = removePauses(a.t, v('kmh'), v('secs'), close);
          const saved = s.elapsed! - (info(next).stats.elapsed ?? 0);
          message = `Removed ${removed(next)} points in pauses` + (close && saved > 0 ? ` and ${dur(saved)} of paused time.` : '.');
          if (count(next) === n && !saved) return notify('No pauses found with these settings.');
          break;
        }
        case 'spikes':
          next = removeSpikes(a.t, v('kmh'));
          message = `Removed ${removed(next)} spike points.`;
          if (count(next) === n) return notify('No spikes found with these settings.');
          break;
        case 'outliers': {
          next = removePoints(a.t, findOutliers(a.t, v('dist'), v('run')));
          message = `Removed ${removed(next)} outlier points.`;
          if (count(next) === n) return notify('No outliers found with these settings.');
          break;
        }
        case 'simplify':
          next = simplify(a.t, v('tol'));
          message = `Simplified: ${count(next).toLocaleString()} of ${n.toLocaleString()} points kept.`;
          if (count(next) === n) return notify('Nothing to simplify at this tolerance.');
          break;
        case 'privacy':
          next = privacy(a.t, v('start'), v('end'));
          message = `Hid ${removed(next)} points at the start and end.`;
          if (count(next) === n) return notify('No points to hide with these distances.');
          break;
        case 'smooth':
          if (!info(a.t).hasEle) return notify('This track has no elevation data.', 'error');
          next = smoothElevation(a.t, v('win'));
          message = 'Elevation smoothed.';
          break;
        case 'shift': {
          const ms = Math.round(v('offset') * v('unit'));
          if (!ms) return;
          next = shiftTime(a.t, ms);
          message = `Times shifted by ${ms < 0 ? '−' : '+'}${dur(Math.abs(ms))}.`;
          break;
        }
        case 'start': {
          const at = new Date(`${form.startDate.value}T${form.startTime.value}`).getTime();
          if (!Number.isFinite(at)) return;
          next = shiftTime(a.t, at - s.start!);
          message = `Start time set to ${dateFmt.format(at)}.`;
          break;
        }
        default:
          next = reverse(a.t);
          message = 'Track reversed.';
      }
      commit(() => (a.t = next), message);
    });
  }
  $<HTMLFormElement>('[data-clean="simplify"]').addEventListener('input', renderSimplify);
  $<HTMLFormElement>('[data-clean="outliers"]').addEventListener('input', renderOutliers);

  // ---------- Export ----------
  function exportList(): Item[] {
    const scope = radio('gx-scope');
    if (scope === 'all') return items;
    if (scope === 'ticked') return tickedItems();
    const a = active();
    return a ? [a] : [];
  }
  function exportItems(group: Item[], each: boolean) {
    if (!group.length) return;
    const write = (g: Item[]) => {
      const text = serializeGpx({
        name: g.length === 1 ? g[0].t.name : '',
        desc: '',
        ns: Object.assign({}, ...g.map((i) => i.ns)),
        wpts: g.flatMap((i) => i.wpts),
        tracks: g.map((i) => i.t),
      });
      const name = fileName(g.length === 1 ? g[0].t.name : 'tracks');
      downloadBlob(new Blob([text], { type: 'application/gpx+xml' }), name);
      return name;
    };
    const names = each ? group.map((i) => write([i])) : [write(group)];
    notify(`Exported ${names.join(', ')}.`);
  }
  exportBtn.addEventListener('click', () => exportItems(exportList(), eachBox.checked));
  root.querySelector('.gx-export')!.addEventListener('change', () => renderInspector());

  // ---------- Toolbar, files, keys ----------
  input.addEventListener('change', () => {
    void addFiles([...(input.files ?? [])]);
    input.value = '';
  });
  $('[data-open]').addEventListener('click', () => input.click());
  undoBtn.addEventListener('click', undo);
  redoBtn.addEventListener('click', redo);
  fitBtn.addEventListener('click', fit);
  closeAll.addEventListener('click', () =>
    commit(() => {
      items = [];
      ticked.clear();
    }, 'All tracks closed. Undo brings them back.'),
  );
  $('[data-msg-close]').addEventListener('click', () => notify(''));
  const setToggle = (b: HTMLButtonElement, on: boolean) => b.setAttribute('aria-pressed', String(on));
  toggles.points.addEventListener('click', () => {
    showPoints = !showPoints;
    setToggle(toggles.points, showPoints);
    draw();
  });
  toggles.profile.addEventListener('click', () => {
    const on = !root.hasAttribute('data-profile');
    root.toggleAttribute('data-profile', on);
    setToggle(toggles.profile, on);
    draw();
  });
  toggles.hr.addEventListener('click', () => {
    showHr = !showHr;
    setToggle(toggles.hr, showHr);
    draw();
  });

  root.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    root.classList.add('gx-over');
  });
  root.addEventListener('dragleave', (e) => {
    if (!root.contains(e.relatedTarget as Node | null)) root.classList.remove('gx-over');
  });
  root.addEventListener('drop', (e) => {
    root.classList.remove('gx-over');
    if (!e.dataTransfer?.files.length) return;
    e.preventDefault();
    void addFiles([...e.dataTransfer.files]);
  });

  document.addEventListener('keydown', (e) => {
    const inApp = root.contains(document.activeElement) || document.activeElement === document.body;
    if (!inApp || e.defaultPrevented) return;
    const typing = !!(e.target as Element).closest('input:not([type="checkbox"], [type="radio"], [type="color"]), textarea, select, [contenteditable]');
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && !e.altKey && key === 's') {
      e.preventDefault();
      exportItems(exportList(), eachBox.checked);
    } else if (typing) return;
    else if (mod && ((key === 'z' && e.shiftKey) || key === 'y')) {
      e.preventDefault();
      redo();
    } else if (mod && key === 'z') {
      e.preventDefault();
      undo();
    } else if (mod || e.altKey) return;
    else if ((e.key === 'Delete' || e.key === 'Backspace') && mark !== null) {
      e.preventDefault();
      deleteMark();
    } else if (e.key === 'Escape' && (sel || mark !== null)) selAction.clear();
    else if (key === 'f' && items.length) fit();
    else if (key === 'p') toggles.points.click();
  });

  // Modes from the hub: ?mode=merge readies multi-select, ?mode=clean opens the clean-up tools.
  root.toggleAttribute('data-profile', true);
  function applyMode(next: string | null) {
    mode = next;
    $('[data-merge-sec]').toggleAttribute('data-highlight', mode === 'merge');
    $('[data-clean-sec]').toggleAttribute('data-highlight', mode === 'clean');
    if (mode === 'merge' || mode === 'clean') {
      const sec = $(mode === 'merge' ? '[data-merge-sec]' : '[data-clean-sec]');
      if (mode === 'merge') ($<HTMLInputElement>('input[name="gx-scope"][value="ticked"]')).checked = true;
      requestAnimationFrame(() => (insp.scrollTop = sec.offsetTop - insp.offsetTop - 8));
    }
    refresh();
  }
  window.addEventListener('tools:mode', (e) => applyMode((e as CustomEvent<string | null>).detail));
  applyMode(mode);
}
