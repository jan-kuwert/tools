// Run: node --test src/lib/color.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { contrast, formatColor, formatRatio, hsvToRgb, paletteCss, parseColor, parseCssColors, parseHex, rgbToHsv, toHex } from './color.ts';

test('parseHex accepts 3 and 6 digits, with or without #, and rejects the rest', () => {
  assert.deepEqual(parseHex('#fff'), [255, 255, 255]);
  assert.deepEqual(parseHex('4f46E5'), [79, 70, 229]);
  assert.equal(parseHex('#ffff'), null);
  assert.equal(parseHex('red'), null);
  assert.equal(toHex(parseHex('#0a0B0c')), '#0a0b0c');
});

test('contrast matches WCAG reference values and never rounds up to a threshold', () => {
  assert.equal(contrast(parseHex('#000'), parseHex('#fff')), 21);
  assert.equal(contrast(parseHex('#777'), parseHex('#fff')), contrast(parseHex('#fff'), parseHex('#777')));
  // #767676 is the lightest grey that passes AA on white; #777777 is just below 4.5.
  assert.ok(contrast(parseHex('#767676'), parseHex('#fff')) >= 4.5);
  const below = contrast(parseHex('#777777'), parseHex('#fff'));
  assert.ok(below < 4.5);
  assert.equal(formatRatio(below), '4.47:1');
  assert.equal(formatRatio(4.4999), '4.49:1');
});

test('parseColor reads CSS colour syntaxes and rejects translucent ones', () => {
  assert.deepEqual(parseColor('rgb(79, 70, 229)'), [79, 70, 229]);
  assert.deepEqual(parseColor('rgb(79 70 229 / 100%)'), [79, 70, 229]);
  assert.deepEqual(parseColor('hsl(0 100% 50%)'), [255, 0, 0]);
  assert.deepEqual(parseColor('#4f46e5ff'), [79, 70, 229]);
  assert.equal(parseColor('#4f46e580'), null);
  assert.equal(parseColor('rgba(0,0,0,0.5)'), null);
  assert.equal(parseColor('var(--x)'), null);
});

test('RGB and HSL notations map back to the same colour for every 8-bit grey and a hue sweep', () => {
  const samples = [];
  for (let v = 0; v < 256; v += 5) samples.push(toHex([v, v, v]), toHex([v, 255 - v, (v * 7) % 256]), toHex([(v * 3) % 256, v, 128]));
  for (const hex of samples) for (const f of ['rgb', 'hsl']) assert.equal(toHex(parseColor(formatColor(hex, f))), hex, `${hex} as ${f}`);
  assert.equal(formatColor('#4f46e5', 'rgb'), 'rgb(79 70 229)');
});

test('HSV round-trips through RGB', () => {
  for (const hex of ['#4f46e5', '#0e7490', '#f7f7f5', '#000000']) assert.equal(toHex(hsvToRgb(...rgbToHsv(parseHex(hex)))), hex);
});

test('parseCssColors finds light and dark values in light-dark(), dark selectors and dark media queries', () => {
  const p = parseCssColors(`
    /* --commented: #f00; */
    :root { --bg: light-dark(#fff, rgb(17, 18, 20)); --fg: #111; --link: #00e; --alias: var(--fg); --glass: rgb(0 0 0 / 0.4); }
    :root[data-theme='dark'] { --fg: #eee; }
    @media (prefers-color-scheme: dark) { :root { --link: hsl(240 100% 80%); } }
  `);
  assert.deepEqual(p.names.sort(), ['bg', 'fg', 'link']);
  assert.deepEqual(p.light, { bg: '#ffffff', fg: '#111111', link: '#0000ee' });
  assert.deepEqual(p.dark, { bg: '#111214', fg: '#eeeeee', link: '#9999ff' });
  assert.equal(p.hasDark, true);
  assert.deepEqual(p.skipped.sort(), ['alias', 'glass']);
  assert.equal(paletteCss(['fg'], p.light, p.dark, true), ':root {\n  color-scheme: light dark;\n  --fg: light-dark(#111111, #eeeeee);\n}\n');
});
