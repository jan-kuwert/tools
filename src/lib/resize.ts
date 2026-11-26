// Shared drag/keyboard resizing for app panes (sidebars, inspectors, output panels).
// The handle should be a focusable `role="separator"` with the right aria-orientation; give it class `pane-resizer`.
import { loadPrefs, savePrefs } from './prefs';

export interface ResizeOptions {
  /** Persisted under prefs.paneSizes[key]; omit to not persist. */
  key?: string;
  min: () => number;
  max: () => number;
  initial: number;
  apply: (px: number) => void;
  /** New size from the pointer position, given the size at drag start. */
  fromPointer: (e: PointerEvent, start: { x: number; y: number; size: number }) => number;
  /** Keys that grow/shrink by 16 px, e.g. ArrowLeft/ArrowRight for a right-hand sidebar. */
  growKey: string;
  shrinkKey: string;
  /** Element whose size changes re-clamp the pane (usually the app root). */
  container: HTMLElement;
}

/** Wire a resize handle; returns a setter. Pointer drag, ±16 px keys, Home/End limits, double-click resets. */
export function resizable(handle: HTMLElement, o: ResizeOptions): (px: number) => void {
  let size = o.initial;
  const set = (v: number) => {
    size = Math.round(Math.min(o.max(), Math.max(o.min(), v)));
    o.apply(size);
    handle.ariaValueNow = String(size);
    handle.ariaValueMin = String(o.min());
    handle.ariaValueMax = String(o.max());
    handle.ariaValueText = `${size} pixels`;
  };
  const commit = (v: number | undefined) => {
    if (!o.key) return;
    const paneSizes = { ...loadPrefs().paneSizes };
    if (v === undefined || v === o.initial) delete paneSizes[o.key];
    else paneSizes[o.key] = v;
    savePrefs({ paneSizes });
  };

  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    document.documentElement.classList.add('pane-resizing');
    const start = { x: e.clientX, y: e.clientY, size };
    const move = (ev: PointerEvent) => set(o.fromPointer(ev, start));
    const up = () => {
      handle.removeEventListener('pointermove', move);
      document.documentElement.classList.remove('pane-resizing');
      commit(size);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up, { once: true });
    handle.addEventListener('pointercancel', up, { once: true });
  });
  handle.addEventListener('keydown', (e) => {
    const next = { [o.growKey]: size + 16, [o.shrinkKey]: size - 16, Home: o.min(), End: o.max() }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    set(next);
    commit(size);
  });
  handle.addEventListener('dblclick', () => {
    set(o.initial);
    commit(undefined);
  });
  new ResizeObserver(() => set(size)).observe(o.container);

  set((o.key && loadPrefs().paneSizes?.[o.key]) || o.initial);
  return set;
}
