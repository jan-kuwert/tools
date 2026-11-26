// Audio decode/encode helpers for audio/convert. Kept DOM-free except decodeAudio so the encoders are testable in bun.
import { createEncoder, type WasmMediaEncoder } from 'wasm-media-encoders';
import { UserError, tick, throwIfAborted } from './tool';

export const SAMPLE_RATE = 44100;
const MAX_SECONDS = 60 * 60;
// Multiple of the 1152-sample MP3 frame; ~1.7 s of audio per chunk keeps the UI responsive.
const CHUNK = 1152 * 64;

/** Decode at 44.1 kHz, keeping mono/stereo and downmixing anything wider to stereo. */
export async function decodeAudio(file: Blob): Promise<Float32Array[]> {
  let buf: AudioBuffer;
  try {
    buf = await new OfflineAudioContext(1, 1, SAMPLE_RATE).decodeAudioData(await file.arrayBuffer());
  } catch {
    throw new UserError("Your browser can't decode this file. Try Chrome or Safari for M4A/AAC.");
  }
  if (buf.duration > MAX_SECONDS) throw new UserError('Audio longer than 60 minutes is not supported (it would use too much memory).');
  if (buf.numberOfChannels > 2) {
    // Rendering into a 2-channel context applies the Web Audio speaker downmix rules.
    const ctx = new OfflineAudioContext(2, buf.length, SAMPLE_RATE);
    const src = new AudioBufferSourceNode(ctx, { buffer: buf });
    src.connect(ctx.destination);
    src.start();
    buf = await ctx.startRendering();
  }
  return Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
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

export type LossyParams = { mime: 'audio/mpeg'; bitrate: 128 | 192 | 256 | 320 } | { mime: 'audio/ogg'; vbrQuality: number };

/** Encode MP3/Ogg Vorbis in chunks; `wasm` is the encoder's .wasm URL or bytes. */
export async function encodeLossy(
  channels: Float32Array[],
  sampleRate: number,
  params: LossyParams,
  wasm: string | Uint8Array,
  signal: AbortSignal,
  onProgress: (fraction: number) => void,
): Promise<Blob> {
  const base = { channels: channels.length as 1 | 2, sampleRate };
  let enc: Pick<WasmMediaEncoder<'audio/mpeg'>, 'encode' | 'finalize'>;
  if (params.mime === 'audio/mpeg') {
    const mp3 = await createEncoder('audio/mpeg', wasm);
    mp3.configure({ ...base, bitrate: params.bitrate });
    enc = mp3;
  } else {
    const ogg = await createEncoder('audio/ogg', wasm);
    ogg.configure({ ...base, vbrQuality: params.vbrQuality });
    enc = ogg;
  }
  const parts: BlobPart[] = [];
  const frames = channels[0].length;
  for (let i = 0; i < frames; i += CHUNK) {
    throwIfAborted(signal);
    // Output lives in wasm memory and is overwritten by the next call, so copy it.
    parts.push(enc.encode(channels.map((ch) => ch.subarray(i, i + CHUNK))).slice());
    onProgress(Math.min(1, (i + CHUNK) / frames));
    await tick();
  }
  parts.push(enc.finalize().slice());
  return new Blob(parts, { type: params.mime });
}
