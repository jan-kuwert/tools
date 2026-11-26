/**
 * Re-indent JSON at the token level so number and string tokens are emitted
 * exactly as written (no float rounding, big ints, escapes kept).
 * `text` must already be valid JSON (see jsonError). Empty `indent` minifies.
 */
export function formatJson(text: string, indent: string): string {
  const out: string[] = [];
  const pretty = indent !== '';
  const breaks: string[] = [];
  const br = (depth: number) => (breaks[depth] ??= '\n' + indent.repeat(depth));
  const colon = pretty ? ': ' : ':';
  let depth = 0;
  let i = 0;
  const n = text.length;
  // Skip whitespace and return the next code unit without consuming it.
  const peek = () => {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c !== 32 && c !== 10 && c !== 13 && c !== 9) return c;
      i++;
    }
    return -1;
  };

  while (peek() !== -1) {
    const c = text.charCodeAt(i);
    if (c === 34 /* " */) {
      let end = i;
      for (;;) {
        end = text.indexOf('"', end + 1);
        let bs = 0;
        while (text.charCodeAt(end - 1 - bs) === 92 /* \ */) bs++;
        if (bs % 2 === 0) break;
      }
      out.push(text.slice(i, end + 1));
      i = end + 1;
    } else if (c === 123 || c === 91 /* { [ */) {
      i++;
      const close = c + 2; // } is 125, ] is 93
      if (peek() === close) {
        out.push(c === 123 ? '{}' : '[]');
        i++;
      } else {
        out.push(c === 123 ? '{' : '[');
        if (pretty) out.push(br(++depth));
      }
    } else if (c === 125 || c === 93 /* } ] */) {
      if (pretty) out.push(br(--depth));
      out.push(text[i++]);
    } else if (c === 44 /* , */) {
      out.push(',');
      if (pretty) out.push(br(depth));
      i++;
    } else if (c === 58 /* : */) {
      out.push(colon);
      i++;
    } else {
      // number, true, false, null
      const start = i;
      while (i < n && !' \n\r\t,:]}'.includes(text[i])) i++;
      out.push(text.slice(start, i));
    }
  }
  return out.join('');
}

/** Returns a readable parse error with line/column when the engine reports a position, or null if valid. */
export function jsonError(text: string): string | null {
  try {
    JSON.parse(text);
    return null;
  } catch (err) {
    const msg = (err as Error).message;
    if (/line \d+ column \d+/i.test(msg)) return msg;
    const pos = /position (\d+)/.exec(msg);
    if (!pos) return msg;
    const before = text.slice(0, Number(pos[1]));
    const line = before.split('\n').length;
    const column = before.length - before.lastIndexOf('\n');
    return `${msg} (line ${line}, column ${column})`;
  }
}
