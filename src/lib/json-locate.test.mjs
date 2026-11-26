// Run: node --test src/lib/json-locate.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { jsonErrorAt } from './json-locate.ts';

test('valid JSON has no error offset', () => {
  for (const ok of ['0', '"a\\u00e9"', ' {"a": [1, -2.5e3, true, null, {}, []]} ', '[[[[]]]]', '12345678901234567890']) assert.equal(jsonErrorAt(ok), -1, ok);
});

test('points at the offending character', () => {
  const cases = [
    ['', 0],
    ['{"a": 1,}', 8],
    ['[1, 2,]', 6],
    ['{"a" 1}', 5],
    ['{a: 1}', 1],
    ['[1 2]', 3],
    ['01', 1],
    ['"tab\there"', 0],
    ['{"a": 1} x', 9],
    ['[1, 2', 5],
    ['{\n  "b": [1, 2,],\n}', 15],
  ];
  for (const [text, at] of cases) assert.equal(jsonErrorAt(text), at, JSON.stringify(text));
});
