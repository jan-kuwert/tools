// Run: node --test src/lib/diff.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { diffLines, diffWords, myers, sortJsonKeys } from './diff.ts';

/** Applies an edit script to `a`, checking it is consistent with `b`, and returns the number of non-equal edits. */
function check(a, b, edits) {
  const outA = [];
  const outB = [];
  for (const [op, i, j] of edits) {
    if (op !== 2) outA.push(a[i]);
    if (op !== 1) outB.push(b[j]);
    if (op === 0) assert.equal(a[i], b[j]);
  }
  assert.deepEqual(outA, [...a]);
  assert.deepEqual(outB, [...b]);
  return edits.filter((e) => e[0] !== 0).length;
}

test('myers finds the minimal edit script', () => {
  const cases = [
    ['', '', 0],
    ['abc', '', 3],
    ['', 'abc', 3],
    ['abc', 'abc', 0],
    ['abcabba', 'cbabac', 5],
    ['kitten', 'sitting', 5],
    ['xaxbxc', 'abc', 3],
  ];
  for (const [a, b, d] of cases) assert.equal(check(a, b, myers(a, b, 100)), d, `${a} → ${b}`);
});

test('myers matches brute-force LCS on random inputs', () => {
  let seed = 7;
  const rnd = (n) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
  for (let t = 0; t < 300; t++) {
    const a = Array.from({ length: rnd(12) }, () => 'abc'[rnd(3)]).join('');
    const b = Array.from({ length: rnd(12) }, () => 'abc'[rnd(3)]).join('');
    const lcs = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
    for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    assert.equal(check(a, b, myers(a, b, 100)), a.length + b.length - 2 * lcs[0][0], `${a} → ${b}`);
  }
});

test('myers gives up beyond maxD', () => {
  assert.equal(myers('aaaa', 'bbbb', 3), null);
});

test('diffLines: whitespace option and budget fallback', () => {
  const a = ['x', '  y', 'z'];
  const b = ['x', 'y', 'z'];
  assert.equal(check(a, b, diffLines(a, b).edits), 2);
  const ws = diffLines(a, b, true);
  assert.equal(ws.edits.every((e) => e[0] === 0), true);
  const big = Array.from({ length: 30000 }, (_, i) => `a${i}`);
  const other = Array.from({ length: 30000 }, (_, i) => `b${i}`);
  other[0] = 'a0';
  const r = diffLines(big, other);
  assert.equal(r.exact, false);
  check(big, other, r.edits);
});

test('diffWords marks changed tokens', () => {
  assert.deepEqual(diffWords('"id": 12345678901234567890,', '"id": 12345678901234567891,'), [[[6, 26]], [[6, 26]]]);
  assert.deepEqual(diffWords('same', 'same'), [[], []]);
});

test('sortJsonKeys sorts recursively and keeps tokens verbatim', () => {
  const src = ' { "b": [ {"z": 1.10, "a": -0.0}, 2e10 ], "a": 12345678901234567890, "\\u0041": "x\\"y" } ';
  assert.equal(sortJsonKeys(src), '{"\\u0041":"x\\"y","a":12345678901234567890,"b":[{"a":-0.0,"z":1.10},2e10]}');
  assert.equal(sortJsonKeys('[]'), '[]');
  assert.equal(sortJsonKeys('{ }'), '{}');
  assert.equal(sortJsonKeys('"s"'), '"s"');
});
