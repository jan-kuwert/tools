import { AsyncZipDeflate, Zip, ZipDeflate, ZipPassThrough } from 'fflate';
import type { SevenZipModule } from '7z-wasm';

export interface ArchiveFile {
  name: string;
  blob: Blob;
  mtime: number;
}

/** Relative paths only, without traversal, drive letters or control characters. */
export const safeEntryName = (raw: string) => raw
  .replace(/[\u0000-\u001f]/g, '')
  .split(/[\\/]+/)
  .filter((s) => s && s !== '.' && s !== '..' && !/^[a-z]:$/i.test(s))
  .join('/');

/** Keep folder hierarchies intact; files conflicting with folders or other files get a suffix. */
export function archiveFiles(entries: { file: File; dir: string }[]): ArchiveFile[] {
  const names = entries.map((e, i) => safeEntryName(`${e.dir}/${e.file.name}`) || `file-${i + 1}`);
  const dirs = new Set<string>();
  for (const name of names) {
    for (let i = name.indexOf('/'); i !== -1; i = name.indexOf('/', i + 1)) dirs.add(name.slice(0, i));
  }
  const used = new Set<string>();
  return entries.map((e, i) => {
    const base = names[i];
    let name = base;
    for (let k = 2; used.has(name) || dirs.has(name); k++) name = base.replace(/(\.[^./]*)?$/, ` (${k})$1`);
    used.add(name);
    return { name, blob: e.file, mtime: e.file.lastModified };
  });
}

export async function createZip(files: ArchiveFile[], level: 0 | 1 | 5 | 6 | 9, signal: AbortSignal, onProgress: (fraction?: number) => void): Promise<Blob> {
  const inputs = new Map<string, { data: Uint8Array; mtime: number }>();
  for (const [i, file] of files.entries()) {
    signal.throwIfAborted();
    onProgress(i / files.length);
    inputs.set(file.name, { data: new Uint8Array(await file.blob.arrayBuffer()), mtime: file.mtime });
  }
  onProgress();
  signal.throwIfAborted();
  const { promise, resolve, reject } = Promise.withResolvers<Blob>();
  const chunks: BlobPart[] = [];
  // fflate's object-based zip() flattens into an unsafe map even with a null-prototype input.
  const zipper = new Zip((error, chunk, final) => {
    if (error) return reject(error);
    chunks.push(chunk as BlobPart);
    if (final) resolve(new Blob(chunks, { type: 'application/zip' }));
  });
  const onAbort = () => {
    zipper.terminate();
    reject(new DOMException('Cancelled', 'AbortError'));
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    try {
      for (const [name, { data, mtime }] of inputs) {
        const entry = level === 0 ? new ZipPassThrough(name) : data.length < 160_000 ? new ZipDeflate(name, { level }) : new AsyncZipDeflate(name, { level });
        entry.mtime = mtime;
        zipper.add(entry);
        entry.push(data, true);
      }
      zipper.end();
    } catch (error) {
      reject(error);
    }
    const blob = await promise;
    signal.throwIfAborted();
    return blob;
  } finally {
    signal.removeEventListener('abort', onAbort);
    zipper.terminate();
  }
}

/** WORKERFS keeps blobs read-only; a fixed prefix avoids its inherited-name parent cache. */
export function mountArchiveFiles(sz: SevenZipModule, files: ArchiveFile[], mountpoint: string): string {
  const base = `${mountpoint}/files`;
  sz.FS.mount(sz.WORKERFS, { blobs: files.map((file) => ({ name: `files/${file.name}`, data: file.blob })) }, mountpoint);
  for (const file of files) {
    const path = `${base}/${file.name}`;
    // WORKERFS directory maps also need __proto__ to be an enumerable own entry.
    const parts = file.name.split('/');
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] !== '__proto__') continue;
      const node = sz.FS.lookupPath(`${base}/${parts.slice(0, i + 1).join('/')}`).node;
      Object.defineProperty(node.parent!.contents, node.name, { value: node, enumerable: true, writable: true, configurable: true });
    }
    sz.FS.utime(path, file.mtime, file.mtime);
  }
  return base;
}
