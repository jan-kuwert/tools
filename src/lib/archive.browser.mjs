// Run on the dev server with browser automation: await tab.evaluate(checkArchives).
export default async function checkArchives() {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const base = new URL('.', document.querySelector('link[rel="icon"]').href);
  const { archiveFiles } = await import(new URL('src/lib/archive.ts', base).href);
  const { runSevenZip } = await import(new URL('src/lib/sevenzip.ts', base).href);
  const { default: SevenZip } = await import(new URL('node_modules/7z-wasm/7zz.es6.js', base).href);
  const wasmBinary = new Uint8Array(await (await fetch(new URL('node_modules/7z-wasm/7zz.wasm', base))).arrayBuffer());
  const sz = await SevenZip({ wasmBinary, print: () => {}, printErr: () => {}, stdin: () => null });
  const mtime = new Date(2020, 1, 2, 3, 4, 6).getTime();
  const paths = ['__proto__', 'constructor/value', 'toString/value', 'nested/__proto__/value', 'foo', 'foo/bar', 'foo/bar/baz'];
  const entries = paths.map((path, i) => {
    const slash = path.lastIndexOf('/');
    return { file: new File([`content-${i}`], path.slice(slash + 1), { lastModified: mtime + i * 4000 }), dir: slash < 0 ? '' : path.slice(0, slash) };
  });
  const files = archiveFiles(entries);
  const formats = [{ format: '7z' }, { format: 'zip', password: 'archive-regression' }];
  for (const [index, options] of formats.entries()) {
    const result = await runSevenZip({ op: 'create', ...options, files, level: 0 }, { signal: new AbortController().signal, onProgress: () => {} });
    assert(result.type === 'created', `${options.format}: ${JSON.stringify(result)}`);
    const source = `/check-${index}.${options.format}`;
    const output = `/check-${index}`;
    sz.FS.writeFile(source, new Uint8Array(result.data));
    const rc = sz.callMain(['x', `-o${output}`, '-y', `-p${options.password ?? ''}`, '--', source]);
    assert(rc === 0, `${options.format}: failed to extract real archive (${rc})`);
    for (const [i, file] of files.entries()) {
      const path = `${output}/${file.name}`;
      assert(new TextDecoder().decode(sz.FS.readFile(path)) === `content-${i}`, `${options.format}: missing or changed ${file.name}`);
      assert(Math.abs(sz.FS.stat(path).mtime.getTime() - file.mtime) < 2000, `${options.format}: lost original timestamp for ${file.name}`);
    }
  }
  return '7z and encrypted ZIP retain inherited names, colliding paths, contents and timestamps';
}
