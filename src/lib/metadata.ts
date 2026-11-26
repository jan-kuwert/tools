// Copy EXIF from a source image into a canvas-encoded JPEG, PNG or WebP. ICC profiles are not
// copied on purpose: canvas output is sRGB, so a source profile (e.g. Display P3) would be wrong.

const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));
const EXIF_HEADER = [0x45, 0x78, 0x69, 0x66, 0, 0]; // "Exif\0\0"

/** Raw EXIF TIFF payload of a JPEG, PNG or WebP, if any. */
export async function readExif(file: Blob): Promise<Uint8Array | undefined> {
  const b = new Uint8Array(await file.arrayBuffer());
  const v = new DataView(b.buffer);
  if (b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i + 4 <= b.length && b[i] === 0xff; ) {
      const m = b[i + 1];
      if (m === 0xff) { i++; continue; }
      if (m === 0xda || m === 0xd9) return; // image data starts: no more metadata
      const len = v.getUint16(i + 2);
      if (m === 0xe1 && ascii(b, i + 4, 6) === 'Exif\0\0') return b.slice(i + 10, i + 2 + len);
      i += 2 + len;
    }
  } else if (ascii(b, 1, 3) === 'PNG') {
    for (let i = 8; i + 8 <= b.length; ) {
      const len = v.getUint32(i);
      const type = ascii(b, i + 4, 4);
      if (type === 'eXIf') return b.slice(i + 8, i + 8 + len);
      if (type === 'IEND') return;
      i += 12 + len;
    }
  } else if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') {
    for (let i = 12; i + 8 <= b.length; ) {
      const len = v.getUint32(i + 4, true);
      if (ascii(b, i, 4) === 'EXIF') {
        const p = b.slice(i + 8, i + 8 + len);
        return ascii(p, 0, 6) === 'Exif\0\0' ? p.slice(6) : p; // some writers keep the JPEG prefix
      }
      i += 8 + len + (len & 1);
    }
  }
}

/** IFD0 of a TIFF payload. Throws if malformed. */
function ifd0(t: Uint8Array) {
  const v = new DataView(t.buffer, t.byteOffset, t.byteLength);
  const le = ascii(t, 0, 2) === 'II';
  if ((!le && ascii(t, 0, 2) !== 'MM') || v.getUint16(2, le) !== 42) throw new Error('Not TIFF');
  const start = v.getUint32(4, le);
  const n = v.getUint16(start, le);
  const next = start + 2 + n * 12;
  if (next + 4 > t.length) throw new Error('IFD0 out of bounds');
  return { v, le, next, tags: Array.from({ length: n }, (_, k) => start + 2 + k * 12) };
}

/** Whether the EXIF has a GPS IFD. Throws if malformed. */
export function hasGps(exif: Uint8Array): boolean {
  const { v, le, tags } = ifd0(exif);
  return tags.some((o) => v.getUint16(o, le) === 0x8825);
}

let crcTable: Uint32Array | undefined;
function crc32(b: Uint8Array): number {
  crcTable ??= Uint32Array.from({ length: 256 }, (_, n) => {
    for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
    return n;
  });
  let c = ~0;
  for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

/**
 * Insert `exif` into a canvas-encoded JPEG, PNG or WebP. The pixels are already upright, so
 * Orientation is set to 1; the IFD1 thumbnail is unlinked because it shows the unedited image.
 * Throws if `exif` is malformed or does not fit.
 */
export async function withExif(blob: Blob, exif: Uint8Array): Promise<Blob> {
  const t = exif.slice();
  const { v: tv, le, next, tags } = ifd0(t);
  for (const o of tags) if (tv.getUint16(o, le) === 0x0112) tv.setUint16(o + 8, 1, le);
  tv.setUint32(next, 0, le);

  const b = new Uint8Array(await blob.arrayBuffer());
  const v = new DataView(b.buffer);
  const type = blob.type;
  if (type === 'image/jpeg') {
    const len = 8 + t.length;
    if (len > 0xffff) throw new Error('EXIF too large for JPEG');
    return new Blob([b.subarray(0, 2), new Uint8Array([0xff, 0xe1, len >> 8, len & 0xff, ...EXIF_HEADER]), t, b.subarray(2)], { type });
  }
  if (type === 'image/png') {
    let i = 8;
    while (ascii(b, i + 4, 4) !== 'IDAT') i += 12 + v.getUint32(i);
    const chunk = new Uint8Array(12 + t.length);
    const cv = new DataView(chunk.buffer);
    cv.setUint32(0, t.length);
    chunk.set([0x65, 0x58, 0x49, 0x66], 4); // "eXIf"
    chunk.set(t, 8);
    cv.setUint32(8 + t.length, crc32(chunk.subarray(4, 8 + t.length)));
    return new Blob([b.subarray(0, i), chunk, b.subarray(i)], { type });
  }
  if (type === 'image/webp') {
    const first = ascii(b, 12, 4);
    let head: Uint8Array<ArrayBuffer>;
    let body = b.subarray(12);
    if (first === 'VP8X') {
      head = new Uint8Array(0);
      body = body.slice();
      body[8] |= 0x08; // EXIF flag
    } else {
      if (first !== 'VP8 ' && first !== 'VP8L') throw new Error('Unknown WebP');
      const [w, h, alpha] = first === 'VP8 '
        ? [v.getUint16(26, true) & 0x3fff, v.getUint16(28, true) & 0x3fff, false]
        : [1 + (((b[22] & 0x3f) << 8) | b[21]), 1 + (((b[24] & 0xf) << 10) | (b[23] << 2) | (b[22] >> 6)), (b[24] & 0x10) !== 0];
      head = new Uint8Array(18);
      const hv = new DataView(head.buffer);
      head.set([0x56, 0x50, 0x38, 0x58, 10]); // "VP8X", size 10
      head[8] = 0x08 | (alpha ? 0x10 : 0);
      hv.setUint32(12, (w - 1) | ((h - 1 & 0xff) << 24), true);
      hv.setUint16(16, (h - 1) >> 8, true);
    }
    const exifChunk = new Uint8Array(8 + t.length + (t.length & 1));
    exifChunk.set([0x45, 0x58, 0x49, 0x46]); // "EXIF"
    new DataView(exifChunk.buffer).setUint32(4, t.length, true);
    exifChunk.set(t, 8);
    const riff = new Uint8Array(12);
    riff.set(b.subarray(0, 12));
    new DataView(riff.buffer).setUint32(4, 4 + head.length + body.length + exifChunk.length, true);
    return new Blob([riff, head, body, exifChunk], { type });
  }
  throw new Error(`Cannot add EXIF to ${type}`);
}
