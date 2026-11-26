const STRING = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[\da-fA-F]{4}))*"/y;
const LITERAL = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y;

/**
 * Offset of the first JSON syntax error, or -1 if `text` is valid.
 * V8's JSON.parse messages often omit the position, so the editor finds it itself. Iterative: no stack limit on deep nesting.
 */
export function jsonErrorAt(text: string): number {
  let i = 0;
  const closers: number[] = []; // char codes of the open containers' closers: } or ]
  const ws = () => {
    for (let c = text.charCodeAt(i); c === 32 || c === 10 || c === 13 || c === 9; c = text.charCodeAt(++i));
  };
  const token = (re: RegExp) => {
    ws();
    re.lastIndex = i;
    if (!re.test(text)) return false;
    i = re.lastIndex;
    return true;
  };
  const key = () => {
    if (!token(STRING)) return false;
    ws();
    return text.charCodeAt(i) === 58 /* : */ && ++i > 0;
  };

  for (;;) {
    // A value starts here.
    ws();
    const c = text.charCodeAt(i);
    if (c === 123 || c === 91 /* { [ */) {
      i++;
      ws();
      if (text.charCodeAt(i) === c + 2) i++; // empty {} or []
      else {
        closers.push(c + 2);
        if (c === 123 && !key()) return i;
        continue;
      }
    } else if (!token(c === 34 ? STRING : LITERAL)) return i;

    // After a value: a comma, a closer, or the end of the text.
    for (;;) {
      ws();
      const close = closers.at(-1);
      if (close === undefined) return i < text.length ? i : -1;
      const d = text.charCodeAt(i);
      if (d === close) {
        i++;
        closers.pop();
        continue;
      }
      if (d !== 44 /* , */) return i;
      i++;
      if (close === 125 && !key()) return i;
      break;
    }
  }
}
