// GPX 1.0/1.1 parsing, GPX 1.1 serialization, stats and track edits for the GPX app.
// No DOM: a small XML reader keeps <extensions> verbatim and lets node tests run the same code.
// Tracks and points are treated as immutable; every edit returns a new Track (cheap undo snapshots).
import { UserError } from './tool.ts';

export interface Pt {
  lat: number;
  lon: number;
  ele?: number;
  /** Epoch milliseconds. */
  time?: number;
  /** Inner XML of the point's <extensions>, verbatim (Garmin TrackPointExtension, power, …). */
  ext?: string;
  /** Read from ext for display; ext stays the source of truth on export. */
  hr?: number;
  cad?: number;
}
export interface Wpt { lat: number; lon: number; /** Inner XML, verbatim. */ raw: string }
export interface Track { name: string; type: string; desc: string; route: boolean; ext?: string; segs: Pt[][] }
export interface Gpx {
  name: string;
  desc: string;
  /** Namespace prefix → URI from the root element (gpxtpx, ns3, …), needed by the verbatim extensions. */
  ns: Record<string, string>;
  wpts: Wpt[];
  tracks: Track[];
}

export const MAX_BYTES = 50 * 1024 * 1024;
const R = 6371008.8;
const RAD = Math.PI / 180;

// ---------- XML reader ----------

class XmlError extends Error {}
interface XNode { tag: string; name: string; attrs: Record<string, string>; kids: XNode[]; text: string; inner: [number, number] }

const ENT: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const decode = (s: string): string =>
  s.indexOf('&') < 0
    ? s
    : s.replace(/&(#[xX][\da-fA-F]+|#\d+|\w+);/g, (m, e: string) => {
        if (e[0] !== '#') return ENT[e] ?? m;
        const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
      });
const esc = (s: string): string => s.replace(/[<>&"]/g, (c) => `&${{ '<': 'lt', '>': 'gt', '&': 'amp', '"': 'quot' }[c]};`);

function parseXml(src: string): XNode {
  const NAME = /[^\s/>=]+/y;
  const ATTR = /\s*([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;
  const WS = /\s*/y;
  const stack: XNode[] = [];
  let root: XNode | undefined;
  let i = 0;
  const after = (from: number, token: string, what: string) => {
    const e = src.indexOf(token, from);
    if (e < 0) throw new XmlError(`unclosed ${what}`);
    return e + token.length;
  };
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    const end = lt < 0 ? src.length : lt;
    if (end > i) {
      const t = src.slice(i, end);
      if (stack.length) stack[stack.length - 1].text += decode(t);
      else if (t.trim()) throw new XmlError('text outside the root element');
    }
    if (lt < 0) break;
    if (src.startsWith('<!--', lt)) i = after(lt + 4, '-->', 'comment');
    else if (src.startsWith('<![CDATA[', lt)) {
      i = after(lt + 9, ']]>', 'CDATA section');
      if (stack.length) stack[stack.length - 1].text += src.slice(lt + 9, i - 3);
    } else if (src.startsWith('<?', lt)) i = after(lt + 2, '?>', 'processing instruction');
    else if (src.startsWith('<!', lt)) {
      // DOCTYPE, possibly with an internal subset in [...]; skipped, entities in it are not expanded.
      const close = src.indexOf('>', lt);
      const open = src.indexOf('[', lt);
      i = open >= 0 && open < close ? after(after(open, ']', 'DOCTYPE'), '>', 'DOCTYPE') : after(lt, '>', 'DOCTYPE');
    } else if (src[lt + 1] === '/') {
      const e = after(lt, '>', 'end tag');
      const tag = src.slice(lt + 2, e - 1).trim();
      const top = stack.pop();
      if (!top || top.tag !== tag) throw new XmlError(top ? `<${top.tag}> closed by </${tag}>` : `unexpected </${tag}>`);
      top.inner[1] = lt;
      i = e;
    } else {
      NAME.lastIndex = lt + 1;
      const m = NAME.exec(src);
      if (!m) throw new XmlError('invalid tag');
      // Namespaces ignored: match on local names so gpx:, default and odd prefixes all work.
      const node: XNode = { tag: m[0], name: m[0].slice(m[0].indexOf(':') + 1), attrs: {}, kids: [], text: '', inner: [0, 0] };
      let j = NAME.lastIndex;
      for (let a; (ATTR.lastIndex = j), (a = ATTR.exec(src)); j = ATTR.lastIndex) node.attrs[a[1]] = decode(a[2] ?? a[3]);
      WS.lastIndex = j;
      WS.exec(src);
      j = WS.lastIndex;
      const selfClosing = src[j] === '/';
      if (selfClosing) j++;
      if (src[j] !== '>') throw new XmlError(`malformed <${node.tag}> tag`);
      i = j + 1;
      node.inner = [i, i];
      if (stack.length) stack[stack.length - 1].kids.push(node);
      else if (root) throw new XmlError('more than one root element');
      else root = node;
      if (selfClosing) continue;
      if (node.name === 'extensions') {
        // Kept verbatim, so no need to build (many) nodes for its content.
        const close = `</${node.tag}>`;
        const e = src.indexOf(close, i);
        if (e < 0) throw new XmlError(`<${node.tag}> is not closed`);
        node.inner[1] = e;
        i = e + close.length;
      } else stack.push(node);
    }
  }
  if (stack.length) throw new XmlError(`<${stack[stack.length - 1].tag}> is not closed`);
  if (!root) throw new XmlError('no root element');
  return root;
}

// ---------- GPX ----------

const kid = (n: XNode | undefined, name: string) => n?.kids.find((k) => k.name === name);
const kids = (n: XNode, name: string) => n.kids.filter((k) => k.name === name);
const textOf = (n: XNode | undefined) => (n ? n.text.trim() : '');
const num = (s: string | undefined) => {
  const v = s === undefined || s.trim() === '' ? NaN : Number(s);
  return Number.isFinite(v) ? v : undefined;
};
const extNum = (ext: string, names: string) => num(new RegExp(`<(?:[\\w.-]+:)?(?:${names})\\b[^>]*>\\s*([-\\d.]+)`).exec(ext)?.[1]);

/** Parse GPX text; throws UserError for anything that isn't well-formed XML with a <gpx> root. */
export function parseGpx(text: string): Gpx {
  const src = text.replace(/^\uFEFF/, '');
  let root: XNode;
  try {
    root = parseXml(src);
  } catch (e) {
    if (e instanceof XmlError) throw new UserError(`Not a valid XML file (${e.message}).`);
    throw e;
  }
  if (root.name !== 'gpx') throw new UserError(`Not a GPX file: the XML root is <${root.tag}>, not <gpx>.`);
  const raw = (n: XNode | undefined) => (n ? src.slice(n.inner[0], n.inner[1]) : '');
  const ns: Record<string, string> = {};
  for (const [k, v] of Object.entries(root.attrs)) if (k.startsWith('xmlns:') && k !== 'xmlns:xsi') ns[k.slice(6)] = v;

  const point = (n: XNode): Pt | undefined => {
    const lat = num(n.attrs.lat);
    const lon = num(n.attrs.lon);
    if (lat === undefined || lon === undefined || Math.abs(lat) > 90 || Math.abs(lon) > 180) return undefined;
    const p: Pt = { lat, lon };
    const ele = num(textOf(kid(n, 'ele')));
    if (ele !== undefined) p.ele = ele;
    const time = Date.parse(textOf(kid(n, 'time')));
    if (Number.isFinite(time)) p.time = time;
    const ext = raw(kid(n, 'extensions'));
    if (ext.trim()) {
      p.ext = ext;
      const hr = extNum(ext, 'hr|heartrate');
      const cad = extNum(ext, 'cad|cadence');
      if (hr !== undefined) p.hr = hr;
      if (cad !== undefined) p.cad = cad;
    }
    return p;
  };
  const points = (nodes: XNode[]) => nodes.map(point).filter((p): p is Pt => !!p);
  const track = (n: XNode, route: boolean, segs: Pt[][]): Track => {
    const t: Track = { name: textOf(kid(n, 'name')), type: textOf(kid(n, 'type')), desc: textOf(kid(n, 'desc')), route, segs: segs.filter((s) => s.length) };
    const ext = raw(kid(n, 'extensions'));
    if (ext.trim()) t.ext = ext;
    return t;
  };
  // GPX 1.0 keeps name/desc directly on <gpx>; 1.1 in <metadata>.
  const meta = kid(root, 'metadata') ?? root;
  return {
    name: textOf(kid(meta, 'name')),
    desc: textOf(kid(meta, 'desc')),
    ns,
    wpts: kids(root, 'wpt').flatMap((n) => {
      const p = point(n);
      return p ? [{ lat: p.lat, lon: p.lon, raw: raw(n) }] : [];
    }),
    tracks: [
      ...kids(root, 'rte').map((n) => track(n, true, [points(kids(n, 'rtept'))])),
      ...kids(root, 'trk').map((n) => track(n, false, kids(n, 'trkseg').map((s) => points(kids(s, 'trkpt'))))),
    ],
  };
}

const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');

/** GPX 1.1 text. Namespace declarations from the sources are kept so verbatim extensions stay valid. */
export function serializeGpx(g: Gpx, creator = 'Tools'): string {
  const out: string[] = ['<?xml version="1.0" encoding="UTF-8"?>'];
  const xmlns = Object.entries(g.ns).map(([p, u]) => ` xmlns:${p}="${esc(u)}"`).join('');
  out.push(
    `<gpx version="1.1" creator="${esc(creator)}" xmlns="http://www.topografix.com/GPX/1/1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"${xmlns} xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">`,
  );
  const first = g.tracks.map((t) => timeRange(t)?.[0]).find((v) => v !== undefined);
  if (g.name || g.desc || first !== undefined) {
    out.push(
      '  <metadata>' +
        (g.name ? `<name>${esc(g.name)}</name>` : '') +
        (g.desc ? `<desc>${esc(g.desc)}</desc>` : '') +
        (first !== undefined ? `<time>${iso(first)}</time>` : '') +
        '</metadata>',
    );
  }
  for (const w of g.wpts) out.push(`  <wpt lat="${w.lat}" lon="${w.lon}">${w.raw}</wpt>`);
  const pt = (tag: string, p: Pt, indent: string) =>
    `${indent}<${tag} lat="${p.lat}" lon="${p.lon}">` +
    (p.ele !== undefined ? `<ele>${p.ele}</ele>` : '') +
    (p.time !== undefined ? `<time>${iso(p.time)}</time>` : '') +
    (p.ext !== undefined ? `<extensions>${p.ext}</extensions>` : '') +
    `</${tag}>`;
  const head = (t: Track) =>
    (t.name ? `<name>${esc(t.name)}</name>` : '') +
    (t.desc ? `<desc>${esc(t.desc)}</desc>` : '') +
    (t.type ? `<type>${esc(t.type)}</type>` : '') +
    (t.ext !== undefined ? `<extensions>${t.ext}</extensions>` : '');
  // Schema order: all routes, then all tracks. Points are joined, not spread into push (stack limit on big tracks).
  for (const t of g.tracks.filter((t) => t.route)) {
    out.push(`  <rte>${head(t)}`, t.segs.flat().map((p) => pt('rtept', p, '    ')).join('\n'), '  </rte>');
  }
  for (const t of g.tracks.filter((t) => !t.route)) {
    out.push(`  <trk>${head(t)}`);
    for (const s of t.segs) out.push('    <trkseg>', s.map((p) => pt('trkpt', p, '      ')).join('\n'), '    </trkseg>');
    out.push('  </trk>');
  }
  out.push('</gpx>', '');
  return out.join('\n');
}

// ---------- Measures ----------

export function haversine(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const dLat = (b.lat - a.lat) * RAD;
  const dLon = (b.lon - a.lon) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** A track's points in one array; `brk[i]` marks the first point of a segment, `dist[i]` is metres along the track (gaps between segments not counted). */
export interface Flat { pts: Pt[]; brk: Uint8Array; dist: Float64Array }

export function flatten(t: Track): Flat {
  const pts = t.segs.flat();
  const brk = new Uint8Array(pts.length);
  const dist = new Float64Array(pts.length);
  let i = 0;
  for (const s of t.segs) {
    for (let k = 0; k < s.length; k++, i++) {
      brk[i] = k === 0 ? 1 : 0;
      dist[i] = i === 0 ? 0 : dist[i - 1] + (k === 0 ? 0 : haversine(s[k - 1], s[k]));
    }
  }
  return { pts, brk, dist };
}

export function timeRange(t: Track): [number, number] | undefined {
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of t.segs) for (const p of s) if (p.time !== undefined) (lo = Math.min(lo, p.time)), (hi = Math.max(hi, p.time));
  return lo <= hi ? [lo, hi] : undefined;
}

/** Ascent/descent in metres, ignoring wiggles smaller than `threshold` (GPS elevation noise). */
export function climb(eles: number[], threshold = 3): { ascent: number; descent: number } {
  let ascent = 0;
  let descent = 0;
  let ref = eles[0];
  for (const e of eles) {
    if (e - ref >= threshold) (ascent += e - ref), (ref = e);
    else if (ref - e >= threshold) (descent += ref - e), (ref = e);
  }
  return { ascent, descent };
}

/** Below this speed (m/s) an interval counts as stopped for moving time. */
const MOVING = 0.5;

export interface Stats {
  points: number;
  distance: number;
  start?: number;
  end?: number;
  /** Milliseconds. */
  elapsed?: number;
  moving?: number;
  ascent?: number;
  descent?: number;
  minEle?: number;
  maxEle?: number;
  /** m/s; average over moving time, max over ≥ 10 s windows so single GPS jumps don't count. */
  avgSpeed?: number;
  maxSpeed?: number;
  avgHr?: number;
  maxHr?: number;
}

export function stats(t: Track, f: Flat = flatten(t)): Stats {
  const { pts, brk, dist } = f;
  const s: Stats = { points: pts.length, distance: pts.length ? dist[pts.length - 1] : 0 };
  const range = timeRange(t);
  if (range) [s.start, s.end, s.elapsed] = [range[0], range[1], range[1] - range[0]];
  let moving = 0;
  let movingDist = 0;
  let maxSpeed = 0;
  let segStart = 0;
  let w = 0;
  for (let i = 0; i < pts.length; i++) {
    if (brk[i]) (segStart = i), (w = i);
    const a = pts[i - 1];
    const b = pts[i];
    if (i > segStart && a.time !== undefined && b.time !== undefined && b.time > a.time) {
      const d = dist[i] - dist[i - 1];
      const dt = (b.time - a.time) / 1000;
      if (d / dt >= MOVING) (moving += dt), (movingDist += d);
    }
    if (b.time === undefined) continue;
    // Slide the window start forward while the window would still span ≥ 10 s.
    while (w < i && (pts[w].time === undefined || b.time - (pts[w + 1].time ?? -Infinity) >= 10_000)) w++;
    const tw = pts[w].time;
    if (tw !== undefined && b.time - tw >= 10_000) maxSpeed = Math.max(maxSpeed, (dist[i] - dist[w]) / ((b.time - tw) / 1000));
  }
  if (range) {
    s.moving = moving * 1000;
    if (moving > 0) s.avgSpeed = movingDist / moving;
    if (maxSpeed > 0) s.maxSpeed = maxSpeed;
  }
  const eles = pts.flatMap((p) => (p.ele === undefined ? [] : [p.ele]));
  if (eles.length) {
    Object.assign(s, climb(eles));
    // No Math.min(...eles): spreading 100k+ arguments overflows the stack.
    s.minEle = eles.reduce((a, b) => Math.min(a, b));
    s.maxEle = eles.reduce((a, b) => Math.max(a, b));
  }
  const hrs = pts.flatMap((p) => (p.hr === undefined ? [] : [p.hr]));
  if (hrs.length) {
    s.avgHr = hrs.reduce((a, b) => a + b, 0) / hrs.length;
    s.maxHr = hrs.reduce((a, b) => Math.max(a, b));
  }
  return s;
}

// ---------- Edits ----------

const withSegs = (t: Track, segs: Pt[][]): Track => ({ ...t, segs: segs.filter((s) => s.length) });

/** Points a..b (flat, inclusive) keeping segment breaks. */
function slice(t: Track, a: number, b: number): Pt[][] {
  const out: Pt[][] = [];
  let i = 0;
  for (const s of t.segs) {
    const lo = Math.max(a - i, 0);
    const hi = Math.min(b - i, s.length - 1);
    if (lo <= hi) out.push(s.slice(lo, hi + 1));
    i += s.length;
  }
  return out;
}

/** Map every point (flat index); null drops it. Segments are kept. */
export function mapPts(t: Track, fn: (p: Pt, i: number) => Pt | null): Track {
  let i = 0;
  return withSegs(t, t.segs.map((s) => s.flatMap((p) => fn(p, i++) ?? [])));
}

export const count = (t: Track): number => t.segs.reduce((n, s) => n + s.length, 0);

/** Keep only points a..b. */
export const trim = (t: Track, a: number, b: number): Track => withSegs(t, slice(t, a, b));

/** Remove points a..b; `join` connects the two sides in one segment, otherwise they become separate segments. */
export function cut(t: Track, a: number, b: number, join: boolean): Track {
  const before = slice(t, 0, a - 1);
  const after = slice(t, b + 1, count(t) - 1);
  if (join && before.length && after.length && sameSegment(t, a - 1, b + 1)) {
    return withSegs(t, [...before.slice(0, -1), [...before[before.length - 1], ...after[0]], ...after.slice(1)]);
  }
  return withSegs(t, [...before, ...after]);
}

function sameSegment(t: Track, a: number, b: number): boolean {
  let i = 0;
  for (const s of t.segs) {
    if (a < i + s.length) return b < i + s.length;
    i += s.length;
  }
  return false;
}

/** Two tracks meeting at point `at` (the point is in both). */
export const split = (t: Track, at: number): [Track, Track] => [
  withSegs(t, slice(t, 0, at)),
  { ...withSegs(t, slice(t, at, count(t) - 1)), name: t.name ? `${t.name} (2)` : '' },
];

export const deletePoint = (t: Track, i: number): Track => mapPts(t, (p, k) => (k === i ? null : p));

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

export const movePoint = (t: Track, i: number, lat: number, lon: number): Track =>
  mapPts(t, (p, k) => (k === i ? { ...p, lat: round(lat, 7), lon: round(lon, 7) } : p));

/** Insert a point after flat index i (same segment), interpolating elevation and time. */
export function insertPoint(t: Track, i: number, lat: number, lon: number): Track {
  const { pts } = flatten(t);
  const a = pts[i];
  const b = pts[i + 1];
  const da = haversine(a, { lat, lon });
  const f = b ? da / (da + haversine({ lat, lon }, b) || 1) : 0;
  const p: Pt = { lat: round(lat, 7), lon: round(lon, 7) };
  if (a.ele !== undefined) p.ele = b?.ele !== undefined ? round(a.ele + (b.ele - a.ele) * f, 1) : a.ele;
  if (a.time !== undefined) p.time = b?.time !== undefined ? Math.round(a.time + (b.time - a.time) * f) : a.time;
  let k = 0;
  return withSegs(t, t.segs.map((s) => s.flatMap((q) => (k++ === i ? [q, p] : [q]))));
}

const speedKmh = (a: Pt, b: Pt): number | undefined =>
  a.time !== undefined && b.time !== undefined && b.time > a.time ? (haversine(a, b) / ((b.time - a.time) / 1000)) * 3.6 : undefined;

/**
 * Remove pauses: runs of points moving slower than `kmh` for at least `seconds`. The points where the pause starts
 * and ends are kept; `close` also moves later timestamps back so the pause takes no time.
 */
export function removePauses(t: Track, kmh: number, seconds: number, close: boolean): Track {
  let shift = 0;
  const at = (p: Pt): Pt => (shift && p.time !== undefined ? { ...p, time: p.time - shift } : p);
  return withSegs(
    t,
    t.segs.map((s) => {
      const out: Pt[] = [];
      let i = 0;
      while (i < s.length) {
        let j = i;
        for (let v; j + 1 < s.length && (v = speedKmh(s[j], s[j + 1])) !== undefined && v < kmh; ) j++;
        if (j > i && s[j].time! - s[i].time! >= seconds * 1000) {
          out.push(at(s[i]));
          const gap = s[j].time! - s[i].time!;
          if (close) shift += gap;
          out.push(at(s[j]));
        } else for (let k = i; k <= j; k++) out.push(at(s[k]));
        i = j + 1;
      }
      return out;
    }),
  );
}

/** Drop single points that imply a jump faster than `kmh` both into and out of them. */
export function removeSpikes(t: Track, kmh: number): Track {
  const fast = (a: Pt, b: Pt) => (speedKmh(a, b) ?? 0) > kmh;
  return withSegs(
    t,
    t.segs.map((s) => {
      const out: Pt[] = [];
      for (let i = 0; i < s.length; i++) {
        const prev = out[out.length - 1];
        const p = s[i];
        const next = s[i + 1];
        // Ends have one neighbour: a jump counts as a spike only if the movement beyond that neighbour is plausible.
        const before = out[out.length - 2];
        const spike =
          prev && next
            ? fast(prev, p) && fast(p, next) && !fast(prev, next)
            : prev
              ? fast(prev, p) && !!before && !fast(before, prev)
              : !!next && fast(p, next) && !!s[i + 2] && !fast(next, s[i + 2]);
        if (!spike) out.push(p);
      }
      return out;
    }),
  );
}

/**
 * Flat indices of stray points: runs of 1..`maxRun` consecutive points that all lie farther than `minM` metres
 * (and 5× the track's median step) from the regular points on both sides, while those two stay close to each other;
 * at a segment end, far from the one neighbour while the two points beyond it are regular. Needs no timestamps,
 * unlike removeSpikes. The shortest matching run wins, so a lone jump never swallows good points next to it.
 */
export function findOutliers(t: Track, minM: number, maxRun = 1): number[] {
  const steps = t.segs.flatMap((s) => s.slice(1).map((p, k) => haversine(s[k], p))).sort((a, b) => a - b);
  const limit = Math.max(minM, 5 * (steps[steps.length >> 1] ?? 0));
  const far = (a: Pt, b: Pt) => haversine(a, b) > limit;
  const out: number[] = [];
  let base = 0;
  for (const s of t.segs) {
    const n = s.length;
    const bad = new Uint8Array(n);
    const flag = (i: number, j: number) => bad.fill(1, i, j + 1);
    /** Points i..j are far from every neighbour that exists; with both, those two are close to each other. */
    const stray = (i: number, j: number) => {
      const [prev, next] = [s[i - 1], s[j + 1]];
      for (let k = i; k <= j; k++) if ((prev && !far(s[k], prev)) || (next && !far(s[k], next))) return false;
      return !prev || !next || haversine(prev, next) < Math.min(haversine(prev, s[i]), haversine(s[j], next)) / 2;
    };
    // Interior runs first, so a run at a segment end is only judged against points that are themselves regular
    // (otherwise good leading points before a stray cluster would look like the strays).
    for (let i = 1; i < n - 1; i++) {
      for (let k = 1; k <= maxRun && i + k < n; k++) {
        if (!stray(i, i + k - 1)) continue;
        flag(i, i + k - 1);
        i += k - 1;
        break;
      }
    }
    const regular = (a: number, b: number) => a >= 0 && b < n && !bad[a] && !bad[b] && !far(s[a], s[b]);
    for (let k = 1; k <= maxRun && k + 1 < n; k++) {
      if (!bad[k - 1] && regular(k, k + 1) && stray(0, k - 1)) {
        flag(0, k - 1);
        break;
      }
    }
    for (let k = 1; k <= maxRun && n - k - 2 >= 0; k++) {
      if (!bad[n - k] && regular(n - k - 2, n - k - 1) && stray(n - k, n - 1)) {
        flag(n - k, n - 1);
        break;
      }
    }
    bad.forEach((b, i) => b && out.push(base + i));
    base += n;
  }
  return out;
}

export function removePoints(t: Track, flat: number[]): Track {
  const drop = new Set(flat);
  return mapPts(t, (p, i) => (drop.has(i) ? null : p));
}

/** Douglas–Peucker per segment with a tolerance in metres. */
export function simplify(t: Track, tolerance: number): Track {
  return withSegs(
    t,
    t.segs.map((s) => {
      if (s.length < 3) return s;
      const lat0 = s.reduce((a, p) => a + p.lat, 0) / s.length;
      const kx = R * RAD * Math.cos(lat0 * RAD);
      const ky = R * RAD;
      const x = s.map((p) => p.lon * kx);
      const y = s.map((p) => p.lat * ky);
      const keep = new Uint8Array(s.length);
      keep[0] = keep[s.length - 1] = 1;
      const stack: [number, number][] = [[0, s.length - 1]];
      while (stack.length) {
        const [a, b] = stack.pop()!;
        const dx = x[b] - x[a];
        const dy = y[b] - y[a];
        const len2 = dx * dx + dy * dy;
        let max = -1;
        let at = -1;
        for (let i = a + 1; i < b; i++) {
          let u = len2 ? ((x[i] - x[a]) * dx + (y[i] - y[a]) * dy) / len2 : 0;
          u = Math.max(0, Math.min(1, u));
          const d = Math.hypot(x[i] - x[a] - u * dx, y[i] - y[a] - u * dy);
          if (d > max) (max = d), (at = i);
        }
        if (max > tolerance) {
          keep[at] = 1;
          stack.push([a, at], [at, b]);
        }
      }
      return s.filter((_, i) => keep[i]);
    }),
  );
}

/** Hide the first `startM` and last `endM` metres along the track. */
export function privacy(t: Track, startM: number, endM: number): Track {
  const { dist } = flatten(t);
  const total = dist.length ? dist[dist.length - 1] : 0;
  return mapPts(t, (p, i) => (dist[i] >= startM && dist[i] <= total - endM ? p : null));
}

/** Centred moving average of elevation over `window` points. */
export function smoothElevation(t: Track, window: number): Track {
  const { pts } = flatten(t);
  const half = Math.max(0, Math.floor(window / 2));
  return mapPts(t, (p, i) => {
    if (p.ele === undefined) return p;
    let sum = 0;
    let n = 0;
    for (let k = Math.max(0, i - half); k <= Math.min(pts.length - 1, i + half); k++) {
      const e = pts[k].ele;
      if (e !== undefined) (sum += e), n++;
    }
    return { ...p, ele: round(sum / n, 1) };
  });
}

export const shiftTime = (t: Track, ms: number): Track => mapPts(t, (p) => (p.time === undefined ? p : { ...p, time: p.time + ms }));

/** Reverse direction; timestamps are mirrored so time still runs forward with the same gaps. */
export function reverse(t: Track): Track {
  const r = timeRange(t);
  const segs = t.segs.map((s) => [...s].reverse()).reverse();
  return { ...t, segs: r ? segs.map((s) => s.map((p) => (p.time === undefined ? p : { ...p, time: r[0] + r[1] - p.time }))) : segs };
}

/** Merge into one track, ordered by start time (tracks without time last) or as given; one segment or one per source segment. */
export function merge(tracks: Track[], byTime: boolean, oneSegment: boolean): Track {
  const start = (t: Track) => timeRange(t)?.[0] ?? Infinity;
  const ordered = byTime ? [...tracks].sort((a, b) => start(a) - start(b)) : tracks;
  const segs = ordered.flatMap((t) => t.segs);
  return {
    name: ordered.find((t) => t.name)?.name ?? '',
    type: ordered.find((t) => t.type)?.type ?? '',
    desc: ordered.find((t) => t.desc)?.desc ?? '',
    route: false,
    segs: oneSegment ? [segs.flat()] : segs,
  };
}

/** Pairs of tracks whose time ranges overlap. */
export function overlaps(tracks: Track[]): [Track, Track][] {
  const timed = tracks.flatMap((t) => {
    const r = timeRange(t);
    return r ? [{ t, r }] : [];
  });
  const out: [Track, Track][] = [];
  for (let i = 0; i < timed.length; i++)
    for (let j = i + 1; j < timed.length; j++)
      if (timed[i].r[0] < timed[j].r[1] && timed[j].r[0] < timed[i].r[1]) out.push([timed[i].t, timed[j].t]);
  return out;
}
