// Waveform selection editor for audio/convert: peaks, canvas drawing, handles, zoom, readouts and Web Audio playback.
// Markup and styles live in src/pages/audio/convert.astro (data-* hooks).

const RULER = 18; // CSS px reserved for the time ruler above the waveform.
const BAR_PITCH = 5; // CSS px per waveform bar.
const NUDGE = 0.01;
const BIG_NUDGE = 1;
const MAX_ZOOM = 1024;
const RULER_STEPS = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800];
const NO_TIME = '-:--.---';

/** Min/max per column across all channels, interleaved [min0, max0, min1, max1, …]. */
function computePeaks(channels: Float32Array[], columns: number): Float32Array {
  const len = channels[0].length;
  const out = new Float32Array(columns * 2);
  const perColumn = len / columns;
  for (let c = 0; c < columns; c++) {
    const from = Math.floor(c * perColumn);
    const to = Math.min(len, Math.max(from + 1, Math.floor((c + 1) * perColumn)));
    let lo = Infinity;
    let hi = -Infinity;
    for (const ch of channels) {
      for (let i = from; i < to; i++) {
        const v = ch[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    if (lo <= hi) {
      out[2 * c] = lo;
      out[2 * c + 1] = hi;
    }
  }
  return out;
}

/** m:ss.mmm */
export function formatTime(seconds: number): string {
  const ms = Math.round(seconds * 1000);
  return `${Math.floor(ms / 60000)}:${((ms % 60000) / 1000).toFixed(3).padStart(6, '0')}`;
}

/** Parse m:ss.mmm or plain seconds (comma or dot decimal); undefined when malformed. */
function parseTime(text: string): number | undefined {
  const m = /^\s*(?:(\d+):)?(\d+(?:\.\d*)?|\.\d+)\s*$/.exec(text.replace(',', '.'));
  return m ? Number(m[1] ?? 0) * 60 + Number(m[2]) : undefined;
}

const rulerLabel = (t: number, step: number) => {
  const digits = step < 0.1 ? 2 : step < 1 ? 1 : 0;
  const r = Math.round(t * 100) / 100;
  const min = Math.floor(r / 60);
  return `${min}:${(r - min * 60).toFixed(digits).padStart(digits ? 3 + digits : 2, '0')}`;
};

/** Seconds of leading/trailing silence to trim (the pad next to the sound already excluded); 0 = none on that side. */
export interface Silence {
  lead: number;
  trail: number;
}

/**
 * Leading and trailing silence: 10 ms windows whose RMS on every channel stays below `thresholdDb` dBFS.
 * Keeps `pad` seconds next to the sound so attacks and decays aren't clipped; sides under 50 ms count as none.
 * Undefined when less than `minTotal` seconds would be trimmed, the audio is silent throughout, or `signal` aborts.
 * Only the silent stretches are scanned, and the scan yields to the event loop every ~15 ms.
 */
export async function detectSilence(
  channels: Float32Array[],
  sampleRate: number,
  { thresholdDb = -50, pad = 0.1, minTotal = 0.3, signal }: { thresholdDb?: number; pad?: number; minTotal?: number; signal?: AbortSignal } = {},
): Promise<Silence | undefined> {
  const len = channels[0].length;
  const win = Math.max(1, Math.round(sampleRate * 0.01));
  const limit = 10 ** (thresholdDb / 10); // mean square of a signal at thresholdDb dBFS
  const loud = (from: number, to: number) =>
    channels.some((ch) => {
      let sum = 0;
      for (let i = from; i < to; i++) sum += ch[i] * ch[i];
      return sum / (to - from) > limit;
    });
  let since = performance.now();
  let windows = 0;
  const aborted = async () => {
    if ((++windows & 255) === 0 && performance.now() - since > 15) {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve);
      await promise;
      since = performance.now();
    }
    return !!signal?.aborted;
  };

  let first = 0;
  while (first < len && !loud(first, Math.min(len, first + win))) {
    first += win;
    if (await aborted()) return;
  }
  if (first >= len) return;
  let last = len;
  while (last > first && !loud(Math.max(first, last - win), last)) {
    last -= win;
    if (await aborted()) return;
  }
  const side = (samples: number) => {
    const s = Math.max(0, samples / sampleRate - pad);
    return s < 0.05 ? 0 : s;
  };
  const found = { lead: side(first), trail: side(len - last) };
  return found.lead + found.trail < minTotal || signal?.aborted ? undefined : found;
}

export interface WaveformEditor {
  /** `editable: false` shows and plays the whole file without trim handles (batch mode). */
  load(channels: Float32Array[], sampleRate: number, editable?: boolean): void;
  clear(): void;
  stop(): void;
  readonly selection: { start: number; end: number; duration: number };
  /** Set the selection (seconds, clamped) as if the user had moved the handles. */
  select(start: number, end: number): void;
}

/**
 * `onChange(committed)`: committed is false only for intermediate drag positions.
 * Optional hooks inside `root`: `[data-readout=start|end|sel|pos]` time readouts and a `[data-led=play]` lamp.
 */
export function createWaveform(root: HTMLElement, onChange: (committed: boolean) => void): WaveformEditor {
  const q = <T extends Element>(sel: string) => root.querySelector<T>(sel)!;
  const scroll = q<HTMLElement>('[data-scroll]');
  const track = q<HTMLElement>('[data-track]');
  const canvas = q<HTMLCanvasElement>('canvas');
  const g = canvas.getContext('2d')!;
  const dimStart = q<HTMLElement>('[data-dim=start]');
  const dimEnd = q<HTMLElement>('[data-dim=end]');
  const playhead = q<HTMLElement>('[data-playhead]');
  const handles = { start: q<HTMLElement>('[data-handle=start]'), end: q<HTMLElement>('[data-handle=end]') };
  const inputs = { start: q<HTMLInputElement>('[data-time=start]'), end: q<HTMLInputElement>('[data-time=end]') };
  const playBtn = q<HTMLButtonElement>('[data-play]');
  const playAllBtn = q<HTMLButtonElement>('[data-play-all]');
  const zoomIn = q<HTMLButtonElement>('[data-zoom=in]');
  const zoomOut = q<HTMLButtonElement>('[data-zoom=out]');
  const readout = (key: string) => root.querySelector<HTMLElement>(`[data-readout=${key}]`);
  const readouts = { start: readout('start'), end: readout('end'), sel: readout('sel'), pos: readout('pos') };
  const playLed = root.querySelector<HTMLElement>('[data-led=play]');

  let channels: Float32Array[] | undefined;
  let rate = 1;
  let duration = 0;
  let start = 0;
  let end = 0;
  let zoom = 1;
  let editable = true;
  // Keyed by column count, so it covers zoom levels; cleared on resize and load.
  const peaks = new Map<number, Float32Array>();

  const pct = (t: number) => `${(t / duration) * 100}%`;
  const minLen = () => Math.min(NUDGE, duration / 2);
  const show = (el: HTMLElement | null, t?: number) => el && (el.textContent = t === undefined ? NO_TIME : formatTime(t));

  const paint = () => {
    dimStart.style.width = pct(start);
    dimEnd.style.left = pct(end);
    for (const [key, t] of [['start', start], ['end', end]] as const) {
      const h = handles[key];
      h.style.left = pct(t);
      h.ariaValueMin = '0';
      h.ariaValueMax = String(+duration.toFixed(3));
      h.ariaValueNow = String(+t.toFixed(3));
      h.ariaValueText = formatTime(t);
      inputs[key].value = formatTime(t);
      inputs[key].setCustomValidity('');
      show(readouts[key], t);
    }
    show(readouts.sel, end - start);
  };

  const setSel = (s: number, e: number, committed = true) => {
    const min = minLen();
    start = Math.min(Math.max(s, 0), duration - min);
    end = Math.min(Math.max(e, start + min), duration);
    paint();
    onChange(committed);
  };
  const setStart = (t: number, committed = true) => setSel(Math.min(t, end - minLen()), end, committed);
  const setEnd = (t: number, committed = true) => setSel(start, Math.max(t, start + minLen()), committed);

  const draw = () => {
    const dpr = devicePixelRatio || 1;
    const w = scroll.clientWidth;
    canvas.style.width = `${w}px`;
    const cw = Math.round(w * dpr);
    const ch = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== cw || canvas.height !== ch) [canvas.width, canvas.height] = [cw, ch];
    else g.clearRect(0, 0, cw, ch);
    if (!channels || !w) return;

    // Discrete bars like the empty display's placeholder: one bar per BAR_PITCH CSS px, 60% of the pitch wide.
    const bars = Math.max(1, Math.round((w * zoom) / BAR_PITCH));
    let p = peaks.get(bars);
    if (!p) peaks.set(bars, (p = computePeaks(channels, bars)));
    const x0 = scroll.scrollLeft * dpr;
    const pitch = (w * zoom * dpr) / bars;
    const barW = Math.max(dpr, pitch * 0.6);
    const top = RULER * dpr;
    const half = (ch - top) / 2;
    const mid = top + half;
    g.fillStyle = getComputedStyle(canvas).color;
    g.beginPath();
    for (let i = Math.max(0, Math.floor(x0 / pitch)); i < bars && i * pitch - x0 < cw; i++) {
      const y1 = mid - p[2 * i + 1] * half;
      const y2 = mid - p[2 * i] * half;
      g.rect(i * pitch - x0 + (pitch - barW) / 2, y1, barW, Math.max(dpr, y2 - y1));
    }
    g.fill();

    // Time ruler: ticks at least ~70 CSS px apart.
    const pxPerSec = (w * zoom) / duration;
    const step = RULER_STEPS.find((s) => s * pxPerSec >= 70) ?? RULER_STEPS.at(-1)!;
    g.fillStyle = getComputedStyle(scroll).color;
    g.font = `${10 * dpr}px ui-monospace, Menlo, Consolas, monospace`;
    g.textBaseline = 'top';
    const first = Math.ceil(scroll.scrollLeft / pxPerSec / step);
    for (let k = first; k * step <= Math.min(duration, (scroll.scrollLeft + w) / pxPerSec); k++) {
      const x = Math.round((k * step * pxPerSec - scroll.scrollLeft) * dpr);
      g.fillRect(x, top - 5 * dpr, dpr, 5 * dpr);
      g.fillText(rulerLabel(k * step, step), x + 3 * dpr, 3 * dpr);
    }
  };
  let drawQueued = false;
  const requestDraw = () => {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(() => {
      drawQueued = false;
      draw();
    });
  };

  const canZoomIn = () => !!channels && scroll.clientWidth * zoom * 2 * (devicePixelRatio || 1) <= channels[0].length && zoom < MAX_ZOOM;
  const setZoom = (z: number) => {
    const w = scroll.clientWidth;
    const center = (scroll.scrollLeft + w / 2) / (w * zoom);
    zoom = z;
    track.style.width = `${zoom * 100}%`;
    scroll.scrollLeft = center * w * zoom - w / 2;
    zoomIn.disabled = !canZoomIn();
    zoomOut.disabled = zoom <= 1;
    draw();
  };
  zoomIn.onclick = () => canZoomIn() && setZoom(zoom * 2);
  zoomOut.onclick = () => zoom > 1 && setZoom(zoom / 2);
  scroll.addEventListener('scroll', requestDraw);
  new ResizeObserver(() => {
    peaks.clear();
    if (channels) zoomIn.disabled = !canZoomIn();
    draw();
  }).observe(scroll);
  // Theme colours come from CSS variables; repaint when the theme changes.
  new MutationObserver(requestDraw).observe(document.documentElement, { attributeFilter: ['data-theme'] });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', requestDraw);

  // Pointer: mouse/pen drag selects a new range; a click or touch tap moves the nearer handle.
  // Touch drags are left to the browser so the zoomed waveform and the page stay scrollable.
  const timeAt = (clientX: number) => {
    const r = track.getBoundingClientRect();
    return Math.min(Math.max((clientX - r.left) / r.width, 0), 1) * duration;
  };
  const moveNearest = (t: number) => (Math.abs(t - start) <= Math.abs(t - end) ? setStart(t) : setEnd(t));
  let drag: { kind: 'new' | 'start' | 'end'; anchor: number; x: number; moved: boolean } | undefined;
  let tap: number | undefined;
  track.addEventListener('pointerdown', (e) => {
    if (!channels || !editable || e.button !== 0) return;
    const handle = (e.target as Element).closest<HTMLElement>('[data-handle]');
    if (!handle && e.pointerType === 'touch') {
      tap = e.pointerId;
      return;
    }
    e.preventDefault();
    (handle ?? track).setPointerCapture(e.pointerId);
    handle?.focus();
    drag = { kind: (handle?.dataset.handle as 'start' | 'end') ?? 'new', anchor: timeAt(e.clientX), x: e.clientX, moved: false };
  });
  track.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const t = timeAt(e.clientX);
    if (Math.abs(e.clientX - drag.x) > 3) drag.moved = true;
    if (!drag.moved) return;
    if (drag.kind === 'start') setStart(t, false);
    else if (drag.kind === 'end') setEnd(t, false);
    else setSel(Math.min(drag.anchor, t), Math.max(drag.anchor, t), false);
  });
  track.addEventListener('pointerup', (e) => {
    if (tap === e.pointerId) moveNearest(timeAt(e.clientX));
    else if (drag?.kind === 'new' && !drag.moved) moveNearest(drag.anchor);
    else if (drag) onChange(true);
    drag = tap = undefined;
  });
  track.addEventListener('pointercancel', () => {
    if (drag?.moved) onChange(true);
    drag = tap = undefined;
  });

  for (const key of ['start', 'end'] as const) {
    const set = key === 'start' ? setStart : setEnd;
    handles[key].addEventListener('keydown', (e) => {
      const cur = key === 'start' ? start : end;
      const step = e.shiftKey ? BIG_NUDGE : NUDGE;
      const next = { ArrowLeft: cur - step, ArrowDown: cur - step, ArrowRight: cur + step, ArrowUp: cur + step, Home: 0, End: duration }[e.key];
      if (next === undefined || !channels) return;
      e.preventDefault();
      set(Math.round(next * 1e6) / 1e6);
      handles[key].scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
    inputs[key].addEventListener('input', () => inputs[key].setCustomValidity(''));
    inputs[key].addEventListener('change', () => {
      const t = parseTime(inputs[key].value);
      if (t === undefined || t > duration + 0.0005) {
        inputs[key].setCustomValidity(t === undefined ? 'Use m:ss.mmm (e.g. 0:01.500) or seconds.' : `The audio is ${formatTime(duration)} long.`);
        inputs[key].reportValidity();
        return;
      }
      // The field shows milliseconds, so a value within half a millisecond of the end means the end.
      set(t >= duration - 0.0005 ? duration : t);
    });
  }

  // Playback: AudioBufferSourceNode with offset/duration; the playhead follows the context clock.
  let audio: AudioContext | undefined;
  let buffer: AudioBuffer | undefined;
  let source: AudioBufferSourceNode | undefined;
  let playFrom = 0;
  let playTo = 0;
  let startedAt = 0;
  let pausedAt: number | undefined;
  let raf = 0;
  // While audio plays the play key is a pause key: `data-playing` swaps its icon and label in CSS.
  const setPlaying = (on: boolean) => {
    playBtn.toggleAttribute('data-playing', on);
    playLed?.toggleAttribute('data-on', on);
  };
  const position = () => Math.min(playTo, playFrom + audio!.currentTime - startedAt);
  const stop = () => {
    cancelAnimationFrame(raf);
    if (source) {
      source.onended = null;
      source.stop();
      source.disconnect();
      source = undefined;
    }
    pausedAt = undefined;
    playhead.hidden = true;
    setPlaying(false);
    show(readouts.pos);
  };
  const follow = () => {
    const t = position();
    playhead.style.left = pct(t);
    show(readouts.pos, t);
    raf = requestAnimationFrame(follow);
  };
  const play = (from: number, to: number) => {
    if (!channels) return;
    stop();
    audio ??= new AudioContext();
    if (!buffer) {
      buffer = new AudioBuffer({ length: channels[0].length, numberOfChannels: channels.length, sampleRate: rate });
      channels.forEach((c, i) => buffer!.copyToChannel(c as Float32Array<ArrayBuffer>, i));
    }
    void audio.resume();
    source = new AudioBufferSourceNode(audio, { buffer });
    source.connect(audio.destination);
    source.onended = stop;
    [playFrom, playTo, startedAt] = [from, to, audio.currentTime];
    source.start(0, from, to - from);
    playhead.hidden = false;
    follow();
    setPlaying(true);
  };
  const pause = () => {
    if (!source) return;
    const at = position();
    stop();
    pausedAt = at;
    playhead.style.left = pct(at);
    playhead.hidden = false;
    show(readouts.pos, at);
  };
  playBtn.onclick = () => (source ? pause() : play(pausedAt !== undefined && pausedAt >= start && pausedAt < end ? pausedAt : start, end));
  playAllBtn.onclick = () => play(0, duration);
  root.addEventListener('keydown', (e) => {
    if (e.key !== ' ' || !channels || (e.target as Element).closest('input, button, select, textarea, a, label')) return;
    e.preventDefault();
    playBtn.click();
  });

  const setTransport = (on: boolean) => {
    playBtn.disabled = playAllBtn.disabled = !on;
    if (!on) zoomIn.disabled = zoomOut.disabled = true;
  };
  const clear = () => {
    stop();
    channels = buffer = undefined;
    peaks.clear();
    setTransport(false);
    for (const el of Object.values(readouts)) show(el);
    inputs.start.value = inputs.end.value = '';
    draw();
  };
  setTransport(false);

  return {
    load(next, sampleRate, canEdit = true) {
      clear();
      channels = next;
      rate = sampleRate;
      editable = canEdit;
      duration = next[0].length / sampleRate;
      [start, end] = [0, duration];
      for (const el of [handles.start, handles.end, dimStart, dimEnd]) el.hidden = !editable;
      setTransport(true);
      scroll.scrollLeft = 0;
      setZoom(1);
      paint();
    },
    clear,
    stop,
    get selection() {
      return { start, end, duration };
    },
    select: (s, e) => setSel(s, e),
  };
}
