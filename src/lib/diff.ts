// Myers O(ND) diff for lines and intra-line tokens, plus key-sorted JSON for "Normalize JSON". No imports: runs under `node --test`.

/** 0 = equal, 1 = only in a (removed), 2 = only in b (added). Indices are -1 on the side an edit does not touch. */
export type Edit = [op: 0 | 1 | 2, a: number, b: number];

/**
 * Shortest edit script between `a` and `b`, or null when more than `maxD` edits would be needed.
 * Work is O((N+M)·D) and memory O(D²) after trimming the common prefix and suffix, so callers bound `maxD`.
 */
export function myers<T>(a: ArrayLike<T>, b: ArrayLike<T>, maxD: number): Edit[] | null {
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length;
  let eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) {
    ea--;
    eb--;
  }
  const n = ea - s;
  const m = eb - s;
  const max = Math.min(n + m, maxD);
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = []; // trace[d][k + d] = furthest x on diagonal k after d edits
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[s + x] === b[s + y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) found = d;
    }
    trace.push(v.slice(off - d, off + d + 1));
  }
  if (found < 0) return null;

  const mid: Edit[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d - 1];
    const k = x - y;
    const pk = k === -d || (k !== d && prev[k - 1 + d - 1] < prev[k + 1 + d - 1]) ? k + 1 : k - 1;
    const px = prev[pk + d - 1];
    const py = px - pk;
    while (x > px && y > py) mid.push([0, s + --x, s + --y]);
    if (pk === k + 1) mid.push([2, -1, s + --y]);
    else mid.push([1, s + --x, -1]);
  }
  while (x > 0) mid.push([0, s + --x, s + --y]);

  const out: Edit[] = [];
  for (let i = 0; i < s; i++) out.push([0, i, i]);
  for (let i = mid.length - 1; i >= 0; i--) out.push(mid[i]);
  for (let i = 0; i < a.length - ea; i++) out.push([0, ea + i, eb + i]);
  return out;
}

export interface LineDiff {
  edits: Edit[];
  /** False when the inputs were too different to diff within budget: the middle is shown as one replaced block. */
  exact: boolean;
}

/** Cells of Myers work (≈ (N+M)·D) allowed before falling back; keeps one diff to a few hundred ms. */
const BUDGET = 3e7;

export function diffLines(a: string[], b: string[], ignoreWhitespace = false): LineDiff {
  // Compare integer ids instead of strings: one hash lookup per line.
  const ids = new Map<string, number>();
  const id = (line: string) => {
    const key = ignoreWhitespace ? line.replace(/\s+/g, '') : line;
    let n = ids.get(key);
    if (n === undefined) ids.set(key, (n = ids.size));
    return n;
  };
  const ia = Int32Array.from(a, id);
  const ib = Int32Array.from(b, id);
  const maxD = Math.max(64, Math.min(4000, Math.floor(BUDGET / Math.max(1, a.length + b.length))));
  const edits = myers(ia, ib, maxD);
  if (edits) return { edits, exact: true };

  let s = 0;
  while (s < ia.length && s < ib.length && ia[s] === ib[s]) s++;
  let e = 0;
  while (e < ia.length - s && e < ib.length - s && ia[ia.length - 1 - e] === ib[ib.length - 1 - e]) e++;
  const out: Edit[] = [];
  for (let i = 0; i < s; i++) out.push([0, i, i]);
  for (let i = s; i < ia.length - e; i++) out.push([1, i, -1]);
  for (let i = s; i < ib.length - e; i++) out.push([2, -1, i]);
  for (let i = e; i > 0; i--) out.push([0, ia.length - i, ib.length - i]);
  return { edits: out, exact: false };
}

/** Character ranges [start, end) that differ between two paired lines, by word/punctuation tokens; null if the lines are too long to compare. */
export function diffWords(a: string, b: string): [Array<[number, number]>, Array<[number, number]>] | null {
  const ta = a.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? [];
  const tb = b.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? [];
  if (ta.length + tb.length > 4000) return null;
  const edits = myers(ta, tb, 400);
  if (!edits) return null;
  const ra: Array<[number, number]> = [];
  const rb: Array<[number, number]> = [];
  let pa = 0;
  let pb = 0;
  const mark = (r: Array<[number, number]>, start: number, len: number) => {
    const last = r.at(-1);
    if (last && last[1] === start) last[1] += len;
    else r.push([start, start + len]);
  };
  for (const [op, i, j] of edits) {
    if (op !== 2) {
      if (op === 1) mark(ra, pa, ta[i].length);
      pa += ta[i].length;
    }
    if (op !== 1) {
      if (op === 2) mark(rb, pb, tb[j].length);
      pb += tb[j].length;
    }
  }
  return [ra, rb];
}

/**
 * Valid JSON re-serialised compactly with object keys sorted (by UTF-16 code units) at every depth.
 * Number and string tokens are copied verbatim, so big integers and exact decimals survive.
 */
export function sortJsonKeys(text: string): string {
  let i = 0;
  const ws = () => {
    for (let c = text.charCodeAt(i); c === 32 || c === 10 || c === 13 || c === 9; c = text.charCodeAt(++i));
  };
  const str = () => {
    const start = i++;
    while (text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    return text.slice(start, ++i);
  };
  const value = (): string => {
    ws();
    const c = text[i];
    if (c === '{' || c === '[') {
      i++;
      ws();
      const close = c === '{' ? '}' : ']';
      if (text[i] === close) {
        i++;
        return c + close;
      }
      const parts: Array<[key: string, out: string]> = [];
      for (;;) {
        ws();
        if (c === '{') {
          const key = str();
          ws();
          i++; // :
          parts.push([JSON.parse(key), `${key}:${value()}`]);
        } else parts.push(['', value()]);
        ws();
        if (text[i++] === close) break;
      }
      if (c === '{') parts.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
      return c + parts.map((p) => p[1]).join(',') + close;
    }
    if (c === '"') return str();
    const start = i;
    while (i < text.length && !' \n\r\t,]}'.includes(text[i])) i++;
    return text.slice(start, i);
  };
  return value();
}
