// Run: node --test src/lib/archive.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { Unzip, UnzipInflate } from 'fflate';
import { archiveFiles, createZip } from './archive.ts';

const mtime = new Date(2020, 1, 2, 3, 4, 6).getTime();
const entry = (path, text = path) => {
  const i = path.lastIndexOf('/');
  return { file: new File([text], path.slice(i + 1), { lastModified: mtime }), dir: i < 0 ? '' : path.slice(0, i) };
};

function contents(data) {
  const files = new Map();
  const unzip = new Unzip((file) => {
    const chunks = [];
    file.ondata = (error, chunk, final) => {
      if (error) throw error;
      chunks.push(Buffer.from(chunk));
      if (final) files.set(file.name, Buffer.concat(chunks).toString());
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  unzip.push(data, true);
  return files;
}

test('ZIP retains inherited names and resolves file/directory collisions without moving folders', async () => {
  const inputs = ['foo', 'foo/bar', 'foo/bar/baz', 'foo/bar', 'foo (2)/other', '__proto__', 'constructor/toString/value'];
  const files = archiveFiles(inputs.map((path, i) => entry(path, String(i))));
  assert.deepEqual(files.map((file) => file.name), ['foo (3)', 'foo/bar (2)', 'foo/bar/baz', 'foo/bar (3)', 'foo (2)/other', '__proto__', 'constructor/toString/value']);
  const zip = await createZip(files, 0, new AbortController().signal, () => {});
  const result = contents(new Uint8Array(await zip.arrayBuffer()));
  assert.deepEqual([...result], files.map((file, i) => [file.name, String(i)]));
  assert.deepEqual(archiveFiles([entry('foo/bar'), entry('foo')]).map((file) => file.name), ['foo/bar', 'foo (2)']);
});

test('ZIP deflates both small files and worker-sized inputs', async () => {
  const texts = ['small text', 'large text '.repeat(18000)];
  const files = archiveFiles(texts.map((text, i) => entry(`${i}.txt`, text)));
  const zip = await createZip(files, 6, new AbortController().signal, () => {});
  assert.deepEqual([...contents(new Uint8Array(await zip.arrayBuffer()))], texts.map((text, i) => [`${i}.txt`, text]));
});

test('sanitization cannot introduce unresolved directory collisions', () => {
  const files = archiveFiles([entry('C:/foo'), entry('foo\\bar'), entry('../foo'), entry('foo/bar/baz')]);
  assert.deepEqual(files.map((file) => file.name), ['foo (2)', 'foo/bar (2)', 'foo (3)', 'foo/bar/baz']);
});

test('abort during the final file read rejects instead of producing a ZIP', async () => {
  const controller = new AbortController();
  class CancellingBlob extends Blob {
    async arrayBuffer() {
      const data = await super.arrayBuffer();
      controller.abort();
      return data;
    }
  }
  await assert.rejects(createZip([{ name: 'last.txt', blob: new CancellingBlob(['last']), mtime }], 0, controller.signal, () => {}), { name: 'AbortError' });
});
