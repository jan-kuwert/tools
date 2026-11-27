// Run: node --test src/lib/exif.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { asciiEntry, empty, fromLocalInput, getLocation, parseExif, serializeExif, setLocation, show, toLocalInput, withValue } from './exif.ts';

const sample = (le) => {
  const x = { ...empty(), le };
  x.ifd0 = [asciiEntry(0x010f, 'Canon'), asciiEntry(0x0110, 'EOS R6 with a long model name')];
  x.exif = [asciiEntry(0x9003, '2024:07:14 18:30:05'), withValue({ tag: 0x829a, type: 5, count: 1, data: new Uint8Array(8) }, '1/250', le)];
  setLocation(x, { lat: 48.137154, lon: -11.576124 });
  return x;
};

for (const le of [true, false]) {
  test(`round trip keeps every tag (${le ? 'II' : 'MM'})`, () => {
    const x = sample(le);
    const back = parseExif(serializeExif(x));
    assert.equal(back.le, le);
    for (const s of ['ifd0', 'exif', 'gps']) {
      assert.deepEqual(back[s].map((e) => [e.tag, show(e, le)]), [...x[s]].sort((a, b) => a.tag - b.tag).map((e) => [e.tag, show(e, le)]));
    }
    assert.equal(show(back.exif.find((e) => e.tag === 0x829a), le), '1/250');
    const at = getLocation(back);
    assert.ok(Math.abs(at.lat - 48.137154) < 1e-6 && Math.abs(at.lon + 11.576124) < 1e-6);
  });
}

test('removing the location drops the GPS section and its pointer', () => {
  const x = sample(true);
  setLocation(x, undefined);
  const back = parseExif(serializeExif(x));
  assert.equal(back.gps.length, 0);
  assert.equal(getLocation(back), undefined);
});

test('values that do not fit their type are rejected', () => {
  const short = { tag: 0x8827, type: 3, count: 1, data: new Uint8Array(2) };
  assert.equal(withValue(short, '70000', true), undefined);
  assert.equal(withValue(short, '1.5', true), undefined);
  assert.equal(show(withValue(short, '400', true), true), '400');
  assert.equal(withValue({ tag: 0x829a, type: 5, count: 1, data: new Uint8Array(8) }, '-1', true), undefined);
});

test('an EXIF with every tag removed is still a valid TIFF', () => {
  const back = parseExif(serializeExif(empty()));
  assert.deepEqual([back.ifd0, back.exif, back.gps], [[], [], []]);
});

test('dates convert between EXIF and datetime-local', () => {
  assert.equal(toLocalInput('2024:07:14 18:30:05'), '2024-07-14T18:30:05');
  assert.equal(toLocalInput('0000:00:00 00:00:00'), '');
  assert.equal(fromLocalInput('2024-07-14T18:30'), '2024:07:14 18:30:00');
  assert.equal(fromLocalInput('2024-07-14T18:30:05'), '2024:07:14 18:30:05');
});

test('malformed payloads throw instead of reading out of bounds', () => {
  const t = serializeExif(sample(true));
  assert.throws(() => parseExif(t.slice(0, 20)));
  const bad = t.slice();
  new DataView(bad.buffer).setUint32(4, 0xfffff, true);
  assert.throws(() => parseExif(bad));
  assert.throws(() => parseExif(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])));
});
