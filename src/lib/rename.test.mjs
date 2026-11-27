// Run: node --test src/lib/rename.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { renameOne } from './rename.ts';

const base = { template: '{name}', start: 1, pad: 1, kase: 'keep', spaces: 'keep', find: '', replace: '', strip: false, keepExt: true, lowerExt: false };
const file = (name) => ({ name, lastModified: new Date(2024, 2, 5).getTime(), size: '1.0 KB' });
const run = (name, opts, n = 0) => renameOne(file(name), n, { ...base, ...opts }, '2026-01-02');

test('template, numbering, case and spaces', () => {
  assert.equal(run('My Photo.JPG', { template: '{id}_{name}', kase: 'lower', spaces: 'dash' }, 2), '3_my-photo.JPG');
  assert.equal(run('a.txt', { template: '{id}-{date}-{today}', start: 0, pad: 3 }, 4), '004-2024-03-05-2026-01-02.txt');
  assert.equal(run('hello wORLD_x.md', { kase: 'title' }), 'Hello World_X.md');
  assert.equal(run('a.TXT', { kase: 'upper', lowerExt: true }), 'A.txt');
});

test('find/replace, strip and extension handling', () => {
  assert.equal(run('IMG_0012.png', { find: 'IMG_', replace: 'pic-' }), 'pic-0012.png');
  assert.equal(run('IMG_0012.png', { find: '\\d+', replace: '[$&]', re: /\d+/g }), 'IMG_[0012].png');
  assert.equal(run('a&b (1)!.txt', { strip: true, spaces: 'remove' }), 'ab1.txt');
  assert.equal(run('report.pdf', { keepExt: false, kase: 'upper' }), 'REPORT');
  assert.equal(run('.gitignore', { kase: 'upper' }), '.GITIGNORE');
  assert.equal(run('a.txt', { template: ' ' }), '');
});
