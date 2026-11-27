// Geometry for arranging several images on one canvas, like arranging displays in an OS settings panel.
// Boxes are in output pixels; all functions are pure.

export interface Box { x: number; y: number; w: number; h: number }
export type Align = 'start' | 'center' | 'end';
export type Dir = 'left' | 'right' | 'up' | 'down';
export interface Guides { x: number[]; y: number[] }

const offset = (free: number, align: Align) => Math.round(align === 'start' ? 0 : align === 'end' ? free : free / 2);

/** Side by side, `align` on the vertical axis. */
export function layoutRow(sizes: [number, number][], gap: number, align: Align): Box[] {
  const H = Math.max(...sizes.map(([, h]) => h));
  let x = 0;
  return sizes.map(([w, h]) => {
    const b = { x, y: offset(H - h, align), w, h };
    x += w + gap;
    return b;
  });
}

/** Stacked, `align` on the horizontal axis. */
export function layoutColumn(sizes: [number, number][], gap: number, align: Align): Box[] {
  return layoutRow(sizes.map(([w, h]) => [h, w]), gap, align).map(({ x, y, w, h }) => ({ x: y, y: x, w: h, h: w }));
}

/** `cols` columns of equal cells (the largest block); `align` places each block in its cell on both axes. */
export function layoutGrid(sizes: [number, number][], cols: number, gap: number, align: Align): Box[] {
  const cw = Math.max(...sizes.map(([w]) => w));
  const ch = Math.max(...sizes.map(([, h]) => h));
  return sizes.map(([w, h], i) => ({
    x: (i % cols) * (cw + gap) + offset(cw - w, align),
    y: Math.floor(i / cols) * (ch + gap) + offset(ch - h, align),
    w,
    h,
  }));
}

export function bounds(boxes: Box[]): Box {
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return { x, y, w: Math.max(...boxes.map((b) => b.x + b.w)) - x, h: Math.max(...boxes.map((b) => b.y + b.h)) - y };
}

/** Interiors intersect; touching edges do not count. */
export const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const free = (b: Box, others: Box[]) => others.every((o) => !overlaps(b, o));
const dist = (a: Box, b: Box) => Math.hypot(a.x - b.x, a.y - b.y);

/** Positions on one axis where `size` touches (with `gap`) or aligns with [start, start + len) of another box. */
function axisTargets(start: number, len: number, size: number, gap: number): [pos: number, line: number][] {
  const end = start + len;
  return [
    [end + gap, end], // after it
    [start - gap - size, start], // before it
    [start, start], // start edges aligned
    [end - size, end], // end edges aligned
    [Math.round(start + len / 2 - size / 2), start + len / 2], // centres aligned
  ];
}

/** Snap a dragged box to nearby edges/centres of the others within `threshold`; returns the guides to draw. */
export function snap(box: Box, others: Box[], gap: number, threshold: number): { box: Box; guides: Guides } {
  const pick = (pos: number, targets: [number, number][]) => {
    let best: [number, number] | undefined;
    for (const t of targets) if (Math.abs(t[0] - pos) <= threshold && (!best || Math.abs(t[0] - pos) < Math.abs(best[0] - pos))) best = t;
    return best;
  };
  const sx = pick(box.x, others.flatMap((o) => axisTargets(o.x, o.w, box.w, gap)));
  const sy = pick(box.y, others.flatMap((o) => axisTargets(o.y, o.h, box.h, gap)));
  return { box: { ...box, x: sx?.[0] ?? box.x, y: sy?.[0] ?? box.y }, guides: { x: sx ? [sx[1]] : [], y: sy ? [sy[1]] : [] } };
}

/** The nearest position to `box` that overlaps none of `others`, moving it beside whichever box it hits. */
export function settle(box: Box, others: Box[], gap: number): Box | undefined {
  if (free(box, others)) return box;
  const candidates = others
    .filter((o) => overlaps(box, o))
    .flatMap((o) => [
      { ...box, x: o.x - gap - box.w },
      { ...box, x: o.x + o.w + gap },
      { ...box, y: o.y - gap - box.h },
      { ...box, y: o.y + o.h + gap },
    ])
    .filter((c) => free(c, others));
  return candidates.sort((a, b) => dist(a, box) - dist(b, box))[0];
}

/** Whether `box` sits next to another (within `gap`) and shares part of that edge. */
export function touches(box: Box, others: Box[], gap: number): boolean {
  return others.some((o) => {
    const xShared = box.x < o.x + o.w && o.x < box.x + box.w;
    const yShared = box.y < o.y + o.h && o.y < box.y + box.h;
    const hGap = Math.max(o.x - (box.x + box.w), box.x - (o.x + o.w));
    const vGap = Math.max(o.y - (box.y + box.h), box.y - (o.y + o.h));
    return (yShared && hGap >= 0 && hGap <= gap) || (xShared && vGap >= 0 && vGap <= gap) || overlaps(box, o);
  });
}

/** Move a loose box to the nearest place beside another box, sharing at least a quarter of the shorter edge, without overlapping any. */
export function attach(box: Box, others: Box[], gap: number): Box {
  if (!others.length || touches(box, others, gap)) return box;
  const clampTo = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const candidates = others
    .flatMap((o) => {
      const my = Math.ceil(Math.min(box.h, o.h) / 4);
      const mx = Math.ceil(Math.min(box.w, o.w) / 4);
      const y = clampTo(box.y, o.y - box.h + my, o.y + o.h - my);
      const x = clampTo(box.x, o.x - box.w + mx, o.x + o.w - mx);
      return [
        { ...box, x: o.x + o.w + gap, y },
        { ...box, x: o.x - gap - box.w, y },
        { ...box, x, y: o.y - gap - box.h },
        { ...box, x, y: o.y + o.h + gap },
      ];
    })
    .filter((c) => free(c, others));
  return candidates.sort((a, b) => dist(a, box) - dist(b, box))[0] ?? box;
}

/** Move to the next edge position of any other box in `dir` (touching with `gap` or aligned). */
export function nextEdge(box: Box, others: Box[], gap: number, dir: Dir): Box {
  const horizontal = dir === 'left' || dir === 'right';
  const pos = horizontal ? box.x : box.y;
  const targets = others
    .flatMap((o) => (horizontal ? axisTargets(o.x, o.w, box.w, gap) : axisTargets(o.y, o.h, box.h, gap)))
    .map(([p]) => p)
    .filter((p) => (dir === 'right' || dir === 'down' ? p > pos : p < pos));
  if (!targets.length) return box;
  const next = dir === 'right' || dir === 'down' ? Math.min(...targets) : Math.max(...targets);
  return horizontal ? { ...box, x: next } : { ...box, y: next };
}
