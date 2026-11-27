// Parse an EXIF (TIFF) payload into editable tag lists and write it back. Covers IFD0, the Exif
// sub-IFD and the GPS IFD; the IFD1 thumbnail and the Interop pointer are dropped (withExif unlinks
// IFD1 anyway). Values keep the file's byte order, so untouched tags round-trip byte for byte.

export interface Entry { tag: number; type: number; count: number; data: Uint8Array }
export interface Exif { le: boolean; ifd0: Entry[]; exif: Entry[]; gps: Entry[] }
export type Section = 'ifd0' | 'exif' | 'gps';

const SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };
const EXIF_PTR = 0x8769, GPS_PTR = 0x8825, INTEROP_PTR = 0xa005;

export const empty = (): Exif => ({ le: false, ifd0: [], exif: [], gps: [] });

/** Throws on anything malformed: the payload comes from an untrusted file. */
export function parseExif(t: Uint8Array): Exif {
  const v = new DataView(t.buffer, t.byteOffset, t.byteLength);
  const order = String.fromCharCode(t[0], t[1]);
  const le = order === 'II';
  if ((!le && order !== 'MM') || v.getUint16(2, le) !== 42) throw new Error('Not TIFF');
  const pointers = new Map<number, number>();
  const read = (at: number): Entry[] => {
    if (at + 2 > t.length) throw new Error('IFD out of bounds');
    const n = v.getUint16(at, le);
    if (at + 2 + n * 12 > t.length) throw new Error('IFD out of bounds');
    const out: Entry[] = [];
    for (let k = 0; k < n; k++) {
      const o = at + 2 + k * 12;
      const tag = v.getUint16(o, le), type = v.getUint16(o + 2, le), count = v.getUint32(o + 4, le);
      if (tag === EXIF_PTR || tag === GPS_PTR) { pointers.set(tag, v.getUint32(o + 8, le)); continue; }
      if (tag === INTEROP_PTR || !SIZE[type]) continue;
      const size = SIZE[type] * count;
      const from = size <= 4 ? o + 8 : v.getUint32(o + 8, le);
      if (from + size > t.length) throw new Error('Value out of bounds');
      out.push({ tag, type, count, data: t.slice(from, from + size) });
    }
    return out;
  };
  const ifd0 = read(v.getUint32(4, le));
  const sub = (tag: number) => (pointers.has(tag) ? read(pointers.get(tag)!) : []);
  return { le, ifd0, exif: sub(EXIF_PTR), gps: sub(GPS_PTR) };
}

export function serializeExif(x: Exif): Uint8Array {
  const sorted = (es: Entry[]) => [...es].sort((a, b) => a.tag - b.tag);
  const ptr = (tag: number): Entry => ({ tag, type: 4, count: 1, data: new Uint8Array(4) });
  const ifds = [
    sorted([...x.ifd0, ...(x.exif.length ? [ptr(EXIF_PTR)] : []), ...(x.gps.length ? [ptr(GPS_PTR)] : [])]),
    sorted(x.exif),
    sorted(x.gps),
  ];
  const extra = (es: Entry[]) => es.reduce((s, e) => s + (e.data.length > 4 ? e.data.length + (e.data.length & 1) : 0), 0);
  // IFD0 is written even when empty: readers (and withExif) expect it at offset 8.
  const size = (es: Entry[], i: number) => (es.length || i === 0 ? 2 + es.length * 12 + 4 + extra(es) : 0);
  const at = [8, 8 + size(ifds[0], 0), 8 + size(ifds[0], 0) + size(ifds[1], 1)];
  const t = new Uint8Array(at[2] + size(ifds[2], 2));
  const v = new DataView(t.buffer);
  const le = x.le;
  t.set(le ? [0x49, 0x49] : [0x4d, 0x4d]);
  v.setUint16(2, 42, le);
  v.setUint32(4, 8, le);
  ifds.forEach((es, i) => {
    if (!es.length && i) return;
    let o = at[i];
    let data = o + 2 + es.length * 12 + 4;
    v.setUint16(o, es.length, le);
    for (const e of es) {
      o += 2;
      if (i === 0 && e.tag === EXIF_PTR) e.data = u32(at[1], le);
      if (i === 0 && e.tag === GPS_PTR) e.data = u32(at[2], le);
      v.setUint16(o, e.tag, le);
      v.setUint16(o + 2, e.type, le);
      v.setUint32(o + 4, e.count, le);
      if (e.data.length <= 4) t.set(e.data, o + 8);
      else {
        v.setUint32(o + 8, data, le);
        t.set(e.data, data);
        data += e.data.length + (e.data.length & 1);
      }
      o += 10;
    }
    // next-IFD offset stays 0: no IFD1
  });
  return t;
}

function u32(n: number, le: boolean) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, le);
  return b;
}

// ---------- Values ----------

export const TAGS: Record<Section, Record<number, string>> = {
  ifd0: {
    0x010e: 'Description', 0x010f: 'Camera make', 0x0110: 'Camera model', 0x0112: 'Orientation', 0x011a: 'X resolution',
    0x011b: 'Y resolution', 0x0128: 'Resolution unit', 0x0131: 'Software', 0x0132: 'Modified', 0x013b: 'Artist', 0x0213: 'YCbCr positioning',
    0x8298: 'Copyright',
  },
  exif: {
    0x829a: 'Exposure time', 0x829d: 'F-number', 0x8822: 'Exposure program', 0x8827: 'ISO', 0x9000: 'Exif version',
    0x9003: 'Taken', 0x9004: 'Digitized', 0x9010: 'Time zone (modified)', 0x9011: 'Time zone (taken)', 0x9012: 'Time zone (digitized)',
    0x9101: 'Components', 0x9201: 'Shutter speed (APEX)', 0x9202: 'Aperture (APEX)', 0x9203: 'Brightness', 0x9204: 'Exposure bias',
    0x9205: 'Max aperture', 0x9207: 'Metering mode', 0x9208: 'Light source', 0x9209: 'Flash', 0x920a: 'Focal length', 0x927c: 'Maker note',
    0x9286: 'User comment', 0x9290: 'Subseconds (modified)', 0x9291: 'Subseconds (taken)', 0x9292: 'Subseconds (digitized)',
    0xa000: 'FlashPix version', 0xa001: 'Colour space', 0xa002: 'Width', 0xa003: 'Height', 0xa217: 'Sensing method',
    0xa300: 'File source', 0xa301: 'Scene type', 0xa401: 'Custom rendered', 0xa402: 'Exposure mode', 0xa403: 'White balance',
    0xa404: 'Digital zoom', 0xa405: 'Focal length (35 mm)', 0xa406: 'Scene capture type', 0xa420: 'Image ID', 0xa430: 'Owner',
    0xa431: 'Camera serial number', 0xa432: 'Lens specification', 0xa433: 'Lens make', 0xa434: 'Lens model', 0xa435: 'Lens serial number',
  },
  gps: {
    0x00: 'GPS version', 0x01: 'Latitude ref', 0x02: 'Latitude', 0x03: 'Longitude ref', 0x04: 'Longitude', 0x05: 'Altitude ref',
    0x06: 'Altitude', 0x07: 'GPS time (UTC)', 0x0c: 'Speed unit', 0x0d: 'Speed', 0x10: 'Direction ref', 0x11: 'Direction',
    0x12: 'Map datum', 0x1b: 'Positioning method', 0x1d: 'GPS date', 0x1f: 'Horizontal error',
  },
};

export const tagName = (s: Section, tag: number) => TAGS[s][tag] ?? `Tag 0x${tag.toString(16).padStart(4, '0')}`;

const view = (e: Entry) => new DataView(e.data.buffer, e.data.byteOffset, e.data.byteLength);

/** Numbers of a numeric entry; rationals as [numerator, denominator] pairs. */
export function numbers(e: Entry, le: boolean): (number | [number, number])[] {
  const v = view(e);
  const n = SIZE[e.type];
  return Array.from({ length: e.count }, (_, i) => {
    const o = i * n;
    switch (e.type) {
      case 1: case 7: return v.getUint8(o);
      case 6: return v.getInt8(o);
      case 3: return v.getUint16(o, le);
      case 8: return v.getInt16(o, le);
      case 4: return v.getUint32(o, le);
      case 9: return v.getInt32(o, le);
      case 5: return [v.getUint32(o, le), v.getUint32(o + 4, le)];
      case 10: return [v.getInt32(o, le), v.getInt32(o + 4, le)];
      case 11: return v.getFloat32(o, le);
      default: return v.getFloat64(o, le);
    }
  });
}

export const text = (e: Entry) => new TextDecoder().decode(e.data).replace(/\0+$/, '').trim();

const ratio = ([a, b]: [number, number]) => (b === 1 ? `${a}` : b === 0 ? '0' : a !== 0 && Math.abs(b % a) === 0 ? `${a / Math.abs(a)}/${Math.abs(b / a)}` : `${+(a / b).toFixed(4)}`);

/** Human-readable value. */
export function show(e: Entry, le: boolean): string {
  if (e.type === 2) return text(e);
  if (e.type === 7) {
    const s = new TextDecoder().decode(e.data);
    return /^[\x20-\x7e]{1,16}$/.test(s) ? s : `${e.data.length.toLocaleString()} bytes`;
  }
  return numbers(e, le).map((n) => (Array.isArray(n) ? ratio(n) : `${+n.toFixed(6)}`)).join(', ');
}

/** Can be typed into one text box: text, or a single integer or rational. */
export const editable = (e: Entry) => e.type === 2 || (e.count === 1 && [3, 4, 5, 8, 9, 10].includes(e.type));

export function asciiEntry(tag: number, s: string): Entry {
  const b = new TextEncoder().encode(s);
  const data = new Uint8Array(b.length + 1);
  data.set(b);
  return { tag, type: 2, count: data.length, data };
}

function rationalsEntry(tag: number, type: 5 | 10, rs: [number, number][], le: boolean): Entry {
  const data = new Uint8Array(rs.length * 8);
  const v = new DataView(data.buffer);
  rs.forEach(([a, b], i) => {
    if (type === 5) { v.setUint32(i * 8, a, le); v.setUint32(i * 8 + 4, b, le); }
    else { v.setInt32(i * 8, a, le); v.setInt32(i * 8 + 4, b, le); }
  });
  return { tag, type, count: rs.length, data };
}

/** "1/250" or "2.8" → rational; undefined if not a number. */
function parseRatio(s: string): [number, number] | undefined {
  const m = /^\s*(-?\d+)\s*\/\s*(\d+)\s*$/.exec(s);
  if (m) return Number(m[2]) ? [Number(m[1]), Number(m[2])] : undefined;
  const x = Number(s);
  if (s.trim() === '' || !Number.isFinite(x)) return;
  return Number.isInteger(x) ? [x, 1] : [Math.round(x * 10000), 10000];
}

/** Entry `e` with a typed value, or undefined if the value does not fit its type. */
export function withValue(e: Entry, s: string, le: boolean): Entry | undefined {
  if (e.type === 2) return asciiEntry(e.tag, s);
  if (e.type === 5 || e.type === 10) {
    const r = parseRatio(s);
    const max = e.type === 5 ? 0xffffffff : 0x7fffffff;
    if (!r || (e.type === 5 && r[0] < 0) || Math.abs(r[0]) > max || r[1] > max) return;
    return rationalsEntry(e.tag, e.type, [r], le);
  }
  const x = Number(s);
  const [lo, hi] = ({ 3: [0, 0xffff], 4: [0, 0xffffffff], 8: [-0x8000, 0x7fff], 9: [-0x80000000, 0x7fffffff] } as Record<number, number[]>)[e.type];
  if (s.trim() === '' || !Number.isInteger(x) || x < lo || x > hi) return;
  const data = new Uint8Array(SIZE[e.type]);
  const v = new DataView(data.buffer);
  if (e.type === 3) v.setUint16(0, x, le);
  else if (e.type === 8) v.setInt16(0, x, le);
  else if (e.type === 4) v.setUint32(0, x, le);
  else v.setInt32(0, x, le);
  return { ...e, data };
}

// ---------- Dates ("YYYY:MM:DD HH:MM:SS") ----------

/** EXIF date → datetime-local value, or '' if blank or invalid. */
export function toLocalInput(s: string): string {
  const m = /^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/.exec(s);
  return m && m[1] !== '0000' ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}` : '';
}

/** datetime-local value (with or without seconds) → EXIF date. */
export const fromLocalInput = (s: string) => {
  const [d, t] = s.split('T');
  return `${d.replaceAll('-', ':')} ${(t + ':00').slice(0, 8)}`;
};

// ---------- GPS ----------

export function getLocation(x: Exif): { lat: number; lon: number } | undefined {
  const get = (tag: number) => x.gps.find((e) => e.tag === tag);
  const deg = (tag: number, ref: number, neg: string) => {
    const e = get(tag), r = get(ref);
    if (!e || e.type !== 5 || e.count !== 3) return;
    const [d, m, s] = numbers(e, x.le).map((n) => (Array.isArray(n) && n[1] ? n[0] / n[1] : 0));
    const v = d + m / 60 + s / 3600;
    return r && text(r).toUpperCase() === neg ? -v : v;
  };
  const lat = deg(2, 1, 'S'), lon = deg(4, 3, 'W');
  return lat === undefined || lon === undefined ? undefined : { lat, lon };
}

/** Replace the location; `undefined` removes the whole GPS section (altitude, time and all). */
export function setLocation(x: Exif, at: { lat: number; lon: number } | undefined): void {
  if (!at) { x.gps = []; return; }
  const dms = (v: number): [number, number][] => {
    const a = Math.abs(v);
    const d = Math.floor(a);
    const m = Math.floor((a - d) * 60);
    const s = Math.round(((a - d) * 60 - m) * 60 * 10000);
    return [[d, 1], [m, 1], [s, 10000]];
  };
  const keep = x.gps.filter((e) => e.tag > 4);
  x.gps = [
    { tag: 0, type: 1, count: 4, data: new Uint8Array([2, 3, 0, 0]) },
    asciiEntry(1, at.lat < 0 ? 'S' : 'N'),
    rationalsEntry(2, 5, dms(at.lat), x.le),
    asciiEntry(3, at.lon < 0 ? 'W' : 'E'),
    rationalsEntry(4, 5, dms(at.lon), x.le),
    ...keep,
  ];
}
