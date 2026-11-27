// Run: node --test src/lib/waveform.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { detectSilence } from './waveform.ts';

const RATE = 48000;

/** `pre` s of `floor`, `tone` s of a 440 Hz sine at 0.5, `post` s of `floor`; floor(i) gives the quiet samples. */
function clip(pre, tone, post, floor = () => 0) {
  const a = Math.round(pre * RATE);
  const b = a + Math.round(tone * RATE);
  const out = new Float32Array(b + Math.round(post * RATE));
  for (let i = 0; i < out.length; i++) out[i] = i >= a && i < b ? 0.5 * Math.sin((2 * Math.PI * 440 * i) / RATE) : floor(i);
  return out;
}

const near = (actual, expected, tol, what) => assert.ok(Math.abs(actual - expected) <= tol, `${what}: ${actual} not within ${tol} of ${expected}`);

test('finds leading and trailing silence, keeping the pad', async () => {
  const s = await detectSilence([clip(1, 2, 2), clip(1, 2, 2)], RATE);
  assert.ok(s);
  near(s.lead, 0.9, 0.011, 'lead');
  near(s.trail, 1.9, 0.011, 'trail');
});

test('treats a −60 dBFS noise floor as silence at the −50 dBFS default', async () => {
  // Deterministic pseudo-noise with peaks at 10^(−60/20) = 0.001.
  let seed = 1;
  const noise = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 30 - 1) * 0.001;
  const s = await detectSilence([clip(1, 2, 2, noise)], RATE);
  assert.ok(s);
  near(s.lead, 0.9, 0.011, 'lead');
  near(s.trail, 1.9, 0.011, 'trail');
  // At a −70 dBFS threshold the same floor counts as sound.
  assert.equal(await detectSilence([clip(1, 2, 2, noise)], RATE, { thresholdDb: -70 }), undefined);
});

test('reports nothing without silence, for silence only or below the minimum', async () => {
  assert.equal(await detectSilence([clip(0, 3, 0)], RATE), undefined);
  assert.equal(await detectSilence([new Float32Array(RATE * 2)], RATE), undefined);
  // 0.15 s + 0.15 s minus the pads leaves 0.1 s, under the 0.3 s minimum.
  assert.equal(await detectSilence([clip(0.15, 2, 0.15)], RATE), undefined);
});

test('one-sided silence and abort', async () => {
  const s = await detectSilence([clip(0, 2, 1.5)], RATE);
  assert.deepEqual({ lead: s.lead, trail: +s.trail.toFixed(3) }, { lead: 0, trail: 1.4 });
  const controller = new AbortController();
  controller.abort();
  assert.equal(await detectSilence([clip(1, 1, 1)], RATE, { signal: controller.signal }), undefined);
});
