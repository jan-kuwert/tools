// Audio probe/decode/encode helpers for audio/convert. DOM-free except probeAudio's duration fallback and
// decodeAudio, so the header parsers and encoders are testable in bun.
import { createEncoder, type WasmMediaEncoder } from 'wasm-media-encoders';
import { UserError, tick, throwIfAborted } from './tool';

export const MAX_SECONDS = 60 * 60;
export const TOO_LONG = 'Audio longer than 60 minutes is not supported (it would use too much memory).';
// Multiple of the 1152-sample MP3 frame; ~1.7 s of audio per chunk keeps the UI responsive.
const CHUNK = 1152 * 64;
const STD_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000, 88200, 96000, 176400, 192000];

export interface AudioInfo {
  format: string;
  sampleRate: number;
  channels?: number;
  lossless: boolean;
  /** Seconds; undefined when neither the header nor the browser can tell. */
  duration?: number;
  /** Encoded audio bytes, excluding tags and cover art where the container makes that easy. */
  audioBytes: number;
}

export const sourceKbps = (i: AudioInfo): number | undefined => (i.duration ? (i.audioBytes * 8) / i.duration / 1000 : undefined);

const bytes = async (b: Blob, start: number, len: number) => new Uint8Array(await b.slice(start, start + len).arrayBuffer());
const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const is = (b: Uint8Array, o: number, s: string) => [...s].every((c, i) => b[o + i] === c.charCodeAt(0));
const find = (b: Uint8Array, s: string, from = 0) => {
  for (let i = from; i <= b.length - s.length; i++) if (is(b, i, s)) return i;
  return -1;
};

/** Read format, sample rate, channels and duration from the container header. Falls back to 44.1 kHz. */
export async function probeAudio(file: Blob): Promise<AudioInfo> {
  const info = (await parseHeader(file).catch(() => undefined)) ?? { format: 'Unknown', sampleRate: 44100, lossless: false, audioBytes: file.size };
  info.duration ??= await mediaDuration(file);
  return info;
}

async function parseHeader(file: Blob): Promise<AudioInfo | undefined> {
  let head = await bytes(file, 0, 64 * 1024);
  if (is(head, 4, 'ftyp')) return parseMp4(file);
  if (is(head, 0, 'RIFF') && is(head, 8, 'WAVE')) return parseWav(file);
  if (is(head, 0, 'OggS')) {
    const p = 27 + head[26];
    if (is(head, p, '\x01vorbis')) return { format: 'Ogg Vorbis', channels: head[p + 11], sampleRate: view(head).getUint32(p + 12, true), lossless: false, audioBytes: file.size };
    // Opus always decodes at 48 kHz regardless of the input rate stored in the header.
    if (is(head, p, 'OpusHead')) return { format: 'Ogg Opus', channels: head[p + 9], sampleRate: 48000, lossless: false, audioBytes: file.size };
    return;
  }
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
    // WebM/Matroska: SamplingFrequency (0xB5) as float64 or float32, Channels (0x9F) as 1-byte uint.
    const d = view(head);
    const f8 = find(head, '\xb5\x88');
    const f4 = find(head, '\xb5\x84');
    const ch = find(head, '\x9f\x81');
    const rate = f8 >= 0 ? d.getFloat64(f8 + 2) : f4 >= 0 ? d.getFloat32(f4 + 2) : 48000;
    return { format: 'WebM', sampleRate: Math.round(rate), channels: ch >= 0 ? head[ch + 2] : undefined, lossless: false, audioBytes: file.size };
  }
  let tag = 0;
  if (is(head, 0, 'ID3')) {
    tag = 10 + ((head[6] << 21) | (head[7] << 14) | (head[8] << 7) | head[9]) + (head[5] & 0x10 ? 10 : 0);
    head = await bytes(file, tag, 64 * 1024);
  }
  if (is(head, 0, 'fLaC')) {
    const s = 8; // STREAMINFO is always the first metadata block.
    const sampleRate = (head[s + 10] << 12) | (head[s + 11] << 4) | (head[s + 12] >> 4);
    const total = (head[s + 13] & 0x0f) * 2 ** 32 + view(head).getUint32(s + 14);
    return { format: 'FLAC', sampleRate, channels: ((head[s + 12] >> 1) & 7) + 1, duration: total ? total / sampleRate : undefined, lossless: true, audioBytes: file.size };
  }
  for (let i = 0; i < head.length - 4; i++) {
    if (head[i] !== 0xff || (head[i + 1] & 0xe0) !== 0xe0) continue;
    const layer = (head[i + 1] >> 1) & 3;
    if (layer === 1) {
      const version = (head[i + 1] >> 3) & 3; // 3: MPEG-1, 2: MPEG-2, 0: MPEG-2.5
      const rateIdx = (head[i + 2] >> 2) & 3;
      const brIdx = head[i + 2] >> 4;
      if (version === 1 || rateIdx === 3 || brIdx === 0 || brIdx === 15) continue;
      const sampleRate = [44100, 48000, 32000][rateIdx] / (version === 3 ? 1 : version === 2 ? 2 : 4);
      return { format: 'MP3', sampleRate, channels: head[i + 3] >> 6 === 3 ? 1 : 2, lossless: false, audioBytes: file.size - tag };
    }
    if (layer === 0 && (head[i + 1] & 0xf6) === 0xf0) {
      const sampleRate = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350][(head[i + 2] >> 2) & 0xf];
      if (!sampleRate) continue;
      return { format: 'AAC (ADTS)', sampleRate: aacOutputRate(sampleRate), channels: ((head[i + 2] & 1) << 2) | (head[i + 3] >> 6), lossless: false, audioBytes: file.size - tag };
    }
  }
}

// HE-AAC headers often carry the half-rate core; its SBR layer decodes to double. Plain AAC this low is rare, and upsampling it is harmless.
const aacOutputRate = (rate: number) => (rate <= 24000 ? rate * 2 : rate);

async function parseMp4(file: Blob): Promise<AudioInfo | undefined> {
  let moov: Uint8Array | undefined;
  let mdat = 0;
  for (let o = 0; o + 8 <= file.size; ) {
    const h = await bytes(file, o, 16);
    const d = view(h);
    let size = d.getUint32(0);
    const hdr = size === 1 ? 16 : 8;
    if (size === 1) size = Number(d.getBigUint64(8));
    else if (size === 0) size = file.size - o;
    if (size < hdr) break;
    if (is(h, 4, 'moov')) moov = await bytes(file, o, Math.min(size, 32 << 20));
    if (is(h, 4, 'mdat')) mdat += size - hdr;
    o += size;
  }
  if (!moov) return;
  const codecs: Record<string, string> = { mp4a: 'AAC', alac: 'ALAC', fLaC: 'FLAC', Opus: 'Opus', '.mp3': 'MP3' };
  const [type, e] = Object.keys(codecs).map((t) => [t, find(moov, t)] as const).find(([, i]) => i >= 0) ?? [];
  if (!type || e === undefined) return;
  // The mdhd of the same track is the last one before its sample entry.
  let m = -1;
  for (let i = find(moov, 'mdhd'); i >= 0 && i < e; i = find(moov, 'mdhd', i + 4)) m = i;
  const d = view(moov);
  const v1 = m >= 0 && moov[m + 4] === 1;
  const timescale = m >= 0 ? d.getUint32(m + (v1 ? 24 : 16)) : 0;
  const length = m >= 0 ? (v1 ? Number(d.getBigUint64(m + 28)) : d.getUint32(m + 20)) : 0;
  const rate = STD_RATES.includes(timescale) ? timescale : d.getUint16(e + 28);
  const sampleRate = type === 'Opus' ? 48000 : type === 'mp4a' ? aacOutputRate(rate) : rate;
  return {
    format: `${codecs[type]} (M4A)`,
    sampleRate,
    channels: d.getUint16(e + 20),
    duration: timescale && length ? length / timescale : undefined,
    lossless: type === 'alac' || type === 'fLaC',
    audioBytes: mdat || file.size,
  };
}

async function parseWav(file: Blob): Promise<AudioInfo | undefined> {
  let fmt: DataView | undefined;
  for (let o = 12; o + 8 <= file.size; ) {
    const h = await bytes(file, o, 24);
    const size = view(h).getUint32(4, true);
    if (is(h, 0, 'fmt ')) fmt = view(h.subarray(8));
    else if (is(h, 0, 'data') && fmt) {
      const byteRate = fmt.getUint32(8, true);
      return { format: 'WAV', sampleRate: fmt.getUint32(4, true), channels: fmt.getUint16(2, true), duration: byteRate ? size / byteRate : undefined, lossless: true, audioBytes: size };
    }
    o += 8 + size + (size & 1);
  }
}

function mediaDuration(file: Blob): Promise<number | undefined> {
  const url = URL.createObjectURL(file);
  const a = new Audio();
  a.preload = 'metadata';
  const { promise, resolve } = Promise.withResolvers<number | undefined>();
  const done = (d?: number) => {
    URL.revokeObjectURL(url);
    a.removeAttribute('src');
    resolve(d && Number.isFinite(d) ? d : undefined);
  };
  a.onloadedmetadata = () => done(a.duration);
  a.onerror = () => done();
  setTimeout(done, 5000);
  a.src = url;
  return promise;
}

export type Format = 'mp3' | 'wav' | 'ogg';
type Mp3Config = Parameters<WasmMediaEncoder<'audio/mpeg'>['configure']>[0];
const MP3_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];
const MP3_KBPS = [8, 16, 24, 32, 40, 48, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
/** Approximate libvorbis stereo bitrates for quality 0–9. */
const VORBIS_KBPS = [64, 80, 96, 112, 128, 160, 192, 224, 256, 320];

export interface Plan {
  format: Format;
  sampleRate: number;
  channels: 1 | 2;
  /** MP3 CBR bitrate, or the nominal bitrate for an OGG quality. */
  kbps?: number;
  vbrQuality?: number;
  /** Estimated output size in bytes, when the duration is known. */
  bytes?: number;
}

/** Output settings for one source; `choice` is an MP3 kbps or OGG quality, or 'match' to follow the source. */
export function planOutput(info: AudioInfo, format: Format, choice: number | 'match'): Plan {
  const channels = info.channels === 1 ? 1 : 2;
  const src = info.lossless ? undefined : sourceKbps(info);
  // Lossy→lossy: smallest step not noticeably below the source, so quality holds without inflating the size.
  const atLeast = (list: number[], target: number) => list.find((k) => k >= target * 0.9) ?? list[list.length - 1];
  const plan: Plan = { format, sampleRate: info.sampleRate, channels };
  if (format === 'mp3') {
    plan.sampleRate = MP3_RATES.reduce((a, b) => (Math.abs(b - info.sampleRate) <= Math.abs(a - info.sampleRate) ? b : a));
    // MPEG-2 (16–24 kHz) and MPEG-2.5 (8–12 kHz) only define lower bitrates than MPEG-1.
    const [lo, hi] = plan.sampleRate >= 32000 ? [32, 320] : plan.sampleRate >= 16000 ? [8, 160] : [8, 64];
    const allowed = MP3_KBPS.filter((k) => k >= lo && k <= hi);
    plan.kbps = choice === 'match' ? (src ? atLeast(allowed, src) : Math.min(192, hi)) : Math.min(Math.max(choice, lo), hi);
  } else if (format === 'ogg') {
    plan.vbrQuality = choice === 'match' ? (src ? VORBIS_KBPS.indexOf(atLeast(VORBIS_KBPS, src)) : 5) : choice;
    plan.kbps = VORBIS_KBPS[plan.vbrQuality];
  }
  if (info.duration) plan.bytes = format === 'wav' ? 44 + info.duration * plan.sampleRate * channels * 2 : (info.duration * plan.kbps! * 1000) / 8;
  return plan;
}

/** One line explaining why the output grew noticeably, or ''. Up to ~2% is container/frame overhead, not worth explaining. */
export function growthReason(info: AudioInfo, plan: Plan, outBytes: number, inBytes: number): string {
  if (outBytes <= inBytes * 1.02) return '';
  if (plan.format === 'wav') return 'Larger because WAV is uncompressed.';
  const src = sourceKbps(info);
  if (src && plan.kbps! > src * 1.1) return `Larger because ${plan.kbps} kbps is above the source’s ≈${Math.round(src)} kbps.`;
  return 'Slightly larger: similar bitrate to the source plus format overhead.';
}

/** Decode at `sampleRate` (pass the source rate to avoid resampling), keeping mono/stereo and downmixing wider layouts. */
export async function decodeAudio(file: Blob, sampleRate: number): Promise<Float32Array[]> {
  const ctx = new OfflineAudioContext(1, 1, sampleRate);
  let buf: AudioBuffer;
  try {
    buf = await ctx.decodeAudioData(await file.arrayBuffer());
  } catch {
    throw new UserError("Your browser can't decode this file. Try Chrome or Safari for M4A/AAC.");
  }
  if (buf.duration > MAX_SECONDS) throw new UserError(TOO_LONG);
  if (buf.numberOfChannels > 2) {
    // Rendering into a 2-channel context applies the Web Audio speaker downmix rules.
    const mix = new OfflineAudioContext(2, buf.length, sampleRate);
    const src = new AudioBufferSourceNode(mix, { buffer: buf });
    src.connect(mix.destination);
    src.start();
    buf = await mix.startRendering();
  }
  return Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
}

/** Selection in seconds; `remove` cuts it out instead of keeping it. Fades apply to the start and end of the output. */
export interface Edit {
  start: number;
  end: number;
  remove: boolean;
  fadeIn: number;
  fadeOut: number;
}

/** Apply `edit` to PCM at `sampleRate`, sample-accurately, returning new arrays (input is not modified). */
export function applyEdit(channels: Float32Array[], sampleRate: number, edit: Edit): Float32Array[] {
  const len = channels[0].length;
  const a = Math.min(len, Math.round(edit.start * sampleRate));
  const b = Math.min(len, Math.round(edit.end * sampleRate));
  const out = channels.map((ch) => {
    if (!edit.remove) return ch.slice(a, b);
    const o = new Float32Array(len - (b - a));
    o.set(ch.subarray(0, a));
    o.set(ch.subarray(b), a);
    return o;
  });
  const n = out[0].length;
  if (!n) throw new UserError(edit.remove ? 'Removing the whole file leaves no audio.' : 'The selection is empty.');
  const fadeIn = Math.min(n, Math.round(edit.fadeIn * sampleRate));
  const fadeOut = Math.min(n, Math.round(edit.fadeOut * sampleRate));
  for (const o of out) {
    for (let i = 0; i < fadeIn; i++) o[i] *= i / fadeIn;
    for (let i = 0; i < fadeOut; i++) o[n - 1 - i] *= i / fadeOut;
  }
  return out;
}

/** 16-bit PCM RIFF/WAVE. */
export function encodeWav(channels: Float32Array[], sampleRate: number): Blob {
  const n = channels.length;
  const frames = channels[0].length;
  const dataSize = frames * n * 2;
  const view = new DataView(new ArrayBuffer(44 + dataSize));
  const str = (o: number, s: string) => [...s].forEach((ch, i) => view.setUint8(o + i, ch.charCodeAt(0)));
  str(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, n, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * n * 2, true);
  view.setUint16(32, n * 2, true);
  view.setUint16(34, 16, true);
  str(36, 'data');
  view.setUint32(40, dataSize, true);
  let o = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < n; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  }
  return new Blob([view.buffer], { type: 'audio/wav' });
}

/** Encode MP3 (CBR at plan.kbps) or Ogg Vorbis (plan.vbrQuality) in chunks; `channels` must already be at plan.sampleRate. */
export async function encodeLossy(
  channels: Float32Array[],
  plan: Plan,
  wasm: string | Uint8Array,
  signal: AbortSignal,
  onProgress: (fraction: number) => void,
): Promise<Blob> {
  const base = { channels: channels.length as 1 | 2, sampleRate: plan.sampleRate };
  const mime = plan.format === 'mp3' ? 'audio/mpeg' : 'audio/ogg';
  let enc: Pick<WasmMediaEncoder<'audio/mpeg'>, 'encode' | 'finalize'>;
  if (plan.format === 'mp3') {
    const mp3 = await createEncoder('audio/mpeg', wasm);
    // Explicit output rate: otherwise LAME may resample on its own.
    mp3.configure({ ...base, bitrate: plan.kbps as Mp3Config['bitrate'], outputSampleRate: plan.sampleRate as Mp3Config['outputSampleRate'] });
    enc = mp3;
  } else {
    const ogg = await createEncoder('audio/ogg', wasm);
    ogg.configure({ ...base, vbrQuality: plan.vbrQuality });
    enc = ogg;
  }
  const parts: Uint8Array[] = [];
  const frames = channels[0].length;
  for (let i = 0; i < frames; i += CHUNK) {
    throwIfAborted(signal);
    // Output lives in wasm memory and is overwritten by the next call, so copy it.
    parts.push(enc.encode(channels.map((ch) => ch.subarray(i, i + CHUNK))).slice());
    onProgress(Math.min(1, (i + CHUNK) / frames));
    await tick();
  }
  parts.push(enc.finalize().slice());
  if (plan.format === 'mp3') parts.unshift(lameInfoFrame(parts, frames));
  return new Blob(parts as BlobPart[], { type: mime });
}

/** LAME encoder delay in samples; decoders add their own 529 on top. */
const ENCODER_DELAY = 576;

/**
 * LAME "Info" frame (Xing header for CBR) recording encoder delay and end padding, so decoders that honour it
 * (browsers, FFmpeg, iTunes) output exactly `samples` samples instead of ~50 ms extra silence.
 */
function lameInfoFrame(parts: Uint8Array[], samples: number): Uint8Array {
  const size = parts.reduce((n, p) => n + p.length, 0);
  // Byte at `i` across the parts without concatenating them; `i` must not decrease between calls.
  let part = 0;
  let base = 0;
  const at = (i: number) => {
    while (i >= base + parts[part].length) base += parts[part++].length;
    return parts[part][i - base];
  };
  const h = [at(0), at(1), at(2), at(3)];
  const mpeg1 = ((h[1] >> 3) & 3) === 3;
  const rate = [44100, 48000, 32000][(h[2] >> 2) & 3] / (mpeg1 ? 1 : ((h[1] >> 3) & 3) === 2 ? 2 : 4);
  const kbps = mpeg1 ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320] : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  const frameBytes = (brIdx: number, pad = 0) => Math.floor(((mpeg1 ? 144 : 72) * kbps[brIdx] * 1000) / rate) + pad;
  let frames = 0;
  for (let o = 0; o + 4 <= size; frames++) {
    const b2 = at(o + 2);
    o += frameBytes(b2 >> 4, (b2 >> 1) & 1);
  }
  const tag = 4 + (h[3] >> 6 === 3 ? (mpeg1 ? 17 : 9) : mpeg1 ? 32 : 17); // after the side info
  const lame = tag + 120;
  // Like LAME, raise the bitrate of this one frame when the tag does not fit at the stream's bitrate.
  let brIdx = h[2] >> 4;
  while (frameBytes(brIdx) < lame + 36) brIdx++;
  const out = new Uint8Array(frameBytes(brIdx));
  const v = new DataView(out.buffer);
  out.set([0xff, h[1] | 1, (brIdx << 4) | (h[2] & 0x0c), h[3]]); // no CRC, no padding bit
  const ascii = (o: number, s: string) => [...s].forEach((c, i) => (out[o + i] = c.charCodeAt(0)));
  ascii(tag, 'Info');
  v.setUint32(tag + 4, 0x0f); // frames, bytes, TOC and quality present
  v.setUint32(tag + 8, frames);
  v.setUint32(tag + 12, size + out.length);
  for (let i = 0; i < 100; i++) out[tag + 16 + i] = Math.floor((i * 256) / 100);
  ascii(lame, 'LAME3.100');
  out[lame + 9] = 1; // tag revision 0, CBR
  const padding = frames * (mpeg1 ? 1152 : 576) - ENCODER_DELAY - samples;
  out.set([ENCODER_DELAY >> 4, ((ENCODER_DELAY & 15) << 4) | (padding >> 8), padding & 255], lame + 21);
  v.setUint32(lame + 28, size + out.length);
  // CRC-16 (poly 0x8005, reflected) over the frame up to the CRC field.
  let crc = 0;
  for (let i = 0; i < lame + 34; i++) {
    crc ^= out[i];
    for (let b = 0; b < 8; b++) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
  }
  v.setUint16(lame + 34, crc);
  return out;
}
