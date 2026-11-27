// 7-Zip (WASM) in a dedicated worker. Loaded only when a 7z feature is used; the page terminates it to cancel.
// Inputs are mounted read-only via WORKERFS (no copy); outputs are read from MEMFS and transferred back.
import SevenZip, { type SevenZipModule } from '7z-wasm';
import wasmUrl from '7z-wasm/7zz.wasm?url';
import type { SzFailure, SzRequest, SzResponse } from './sevenzip';

const JOB = '/job';
const IN = `${JOB}/in`;
const OUT = `${JOB}/out`;

let sz: SevenZipModule | undefined;
let line = '';
let lines: string[] = [];
let errors: string[] = [];
let errLine = '';
let written = 0;
let cap = Infinity;
let overCap = false;

const post = (msg: SzResponse, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);

async function load(): Promise<SevenZipModule> {
  if (sz) return sz;
  sz = await SevenZip({
    locateFile: () => wasmUrl,
    // No interactive prompts: passwords always come as -p switches.
    stdin: () => null as unknown as number,
    // Byte-wise stdout so -bsp1 progress ("42%" followed by backspaces) arrives while 7-Zip runs.
    stdout: (c) => {
      if (c === null || c === undefined) return;
      if (c === 10) {
        lines.push(line);
        line = '';
      } else if (c === 8) {
        const m = /(\d+)%/.exec(line);
        if (m) post({ type: 'progress', fraction: Number(m[1]) / 100 });
        line = '';
      } else line += String.fromCharCode(c);
    },
    stderr: (c) => {
      if (c === null || c === undefined) return;
      if (c === 10) {
        if (errLine.trim()) errors.push(errLine.trim());
        errLine = '';
      } else errLine += String.fromCharCode(c);
    },
  });
  // Count every byte 7-Zip writes below OUT; past the cap the write fails with ENOSPC and 7-Zip stops.
  const FS = sz.FS as SevenZipModule['FS'] & { ErrnoError: new (errno: number) => Error };
  const write = FS.write.bind(FS);
  FS.write = (stream, buffer, offset, length, position, canOwn) => {
    if ('path' in stream && typeof stream.path === 'string' && stream.path.startsWith(OUT)) {
      written += length;
      if (written > cap) {
        overCap = true;
        throw new FS.ErrnoError(28);
      }
    }
    return write(stream, buffer, offset, length, position, canOwn);
  };
  return sz;
}

function run(args: string[]): number {
  lines = [];
  errors = [];
  line = errLine = '';
  return sz!.callMain(args) as unknown as number;
}

function rmrf(path: string) {
  const FS = sz!.FS;
  let st;
  try {
    st = FS.lstat(path);
  } catch {
    return;
  }
  if (FS.isDir(st.mode)) {
    for (const n of FS.readdir(path)) if (n !== '.' && n !== '..') rmrf(`${path}/${n}`);
    FS.rmdir(path);
  } else FS.unlink(path);
}

function cleanup() {
  const FS = sz!.FS;
  FS.chdir('/');
  try {
    FS.unmount(IN);
  } catch {
    // not mounted
  }
  rmrf(JOB);
}

/** Files below `dir` (relative paths); symlinks and other special nodes are skipped and counted. */
function walk(dir: string, base = '', out: { path: string; size: number }[] = [], skipped = { n: 0 }) {
  const FS = sz!.FS;
  for (const n of FS.readdir(dir)) {
    if (n === '.' || n === '..') continue;
    const p = `${dir}/${n}`;
    const st = FS.lstat(p);
    if (FS.isDir(st.mode)) walk(p, `${base}${n}/`, out, skipped);
    else if (FS.isFile(st.mode)) out.push({ path: `${base}${n}`, size: st.size });
    else skipped.n++;
  }
  return { files: out, skipped: skipped.n };
}

const fail = (code: SzFailure['code'], message: string): SzFailure => ({ type: 'error', code, message });

/** A plain-words reason from 7-Zip's error output. */
function explain(): SzFailure {
  const all = [...errors, ...lines].join('\n');
  if (/wrong password/i.test(all)) return fail('wrong-password', 'The password is wrong.');
  if (/can ?not open (the file as|encrypted) archive|can't open as archive/i.test(all)) return fail('failed', 'This file is not an archive 7-Zip can read, or it is damaged.');
  if (/unsupported (compression )?method/i.test(all)) return fail('failed', 'The archive uses a compression method that is not supported.');
  if (/data error|crc failed|unexpected end/i.test(all)) return fail('failed', 'The archive is damaged or incomplete.');
  const first = errors.find((e) => /error/i.test(e)) ?? errors[0];
  return fail('failed', first ? `7-Zip reported: ${first.replace(/^ERROR:\s*/i, '')}` : '7-Zip could not process this file.');
}

interface Listing {
  files: number;
  size: number;
  encrypted: boolean;
}

/** `7zz l -slt`: entry count, declared total size and whether any entry is encrypted. */
function list(path: string, password: string): Listing | SzFailure {
  const rc = run(['l', '-slt', '-bb0', '-y', `-p${password}`, '--', path]);
  const all = [...errors, ...lines].join('\n');
  if (rc !== 0) {
    if (/cannot open encrypted archive|wrong password/i.test(all)) return fail(password ? 'wrong-password' : 'password', password ? 'The password is wrong.' : 'This archive is password-protected.');
    return explain();
  }
  const listing: Listing = { files: 0, size: 0, encrypted: false };
  // Entries follow the "----------" separator as blank-line separated "Key = Value" blocks.
  const body = lines.slice(lines.indexOf('----------') + 1).join('\n');
  for (const block of body.split(/\n\s*\n/)) {
    if (!/^Path = /m.test(block)) continue;
    if (/^Folder = \+/m.test(block) || /^Attributes = D/m.test(block)) continue;
    listing.files++;
    listing.size += Number(/^Size = (\d+)/m.exec(block)?.[1] ?? 0);
    if (/^Encrypted = \+/m.test(block)) listing.encrypted = true;
  }
  return listing;
}

const isTar = (path: string) => {
  const FS = sz!.FS;
  if (FS.stat(path).size < 512) return false;
  const s = FS.open(path, 'r');
  const head = new Uint8Array(6);
  FS.read(s, head, 0, 5, 257);
  FS.close(s);
  return String.fromCharCode(...head.subarray(0, 5)) === 'ustar';
};

async function extract(req: Extract<SzRequest, { op: 'extract' }>): Promise<SzResponse> {
  const FS = sz!.FS;
  FS.mkdir(JOB);
  FS.mkdir(IN);
  // Single-stream formats (.xz, .bz2, .gz) name their output after the archive, so keep the base name,
  // reduced to characters that cannot act as wildcards or path separators.
  const base = req.name.split(/[\\/]/).pop()!.replace(/[^\p{L}\p{N}._ -]+/gu, '_').replace(/^[.-]+/, '') || 'archive';
  FS.mount(sz!.WORKERFS, { blobs: [{ name: base, data: req.blob }] }, IN);
  let source = `${IN}/${base}`;
  const password = req.password ?? '';
  // A compressed tar (.tar.gz/.xz/.bz2) unpacks to a single .tar first; that is extracted in a second round.
  for (let round = 0; round < 2; round++) {
    const listing = list(source, password);
    if ('type' in listing) return listing;
    if (listing.encrypted && !password) return fail('password', 'This archive is password-protected.');
    if (listing.files > req.maxEntries) return fail('too-many', `holds more than ${req.maxEntries.toLocaleString()} files`);
    if (listing.size > req.maxBytes) return fail('too-big', 'expands to more than the size limit');
    const out = `${OUT}${round}`;
    FS.mkdir(out);
    written = 0;
    cap = req.maxBytes;
    overCap = false;
    const rc = run(['x', `-o${out}`, '-bsp1', '-bb0', '-y', `-p${password}`, '--', source]);
    cap = Infinity;
    if (overCap) return fail('too-big', 'expands to more than the size limit');
    const { files, skipped } = walk(out);
    if (rc !== 0 && !files.length) return explain();
    if (files.length > req.maxEntries) return fail('too-many', `holds more than ${req.maxEntries.toLocaleString()} files`);
    if (round === 0 && files.length === 1 && isTar(`${out}/${files[0].path}`)) {
      source = `${out}/${files[0].path}`;
      continue;
    }
    const entries: { name: string; data: ArrayBuffer }[] = [];
    for (const f of files) {
      const p = `${out}/${f.path}`;
      entries.push({ name: f.path, data: FS.readFile(p).buffer as ArrayBuffer });
      FS.unlink(p);
    }
    const warning = rc !== 0 ? explain().message : undefined;
    return { type: 'extracted', entries, skipped, warning };
  }
  return fail('failed', 'The archive is nested too deeply.');
}

async function create(req: Extract<SzRequest, { op: 'create' }>): Promise<SzResponse> {
  const FS = sz!.FS;
  FS.mkdir(JOB);
  FS.mkdir(IN);
  // Names are already safe relative paths (no "..", no leading "/"); WORKERFS creates their folders.
  FS.mount(sz!.WORKERFS, { blobs: req.files.map((f) => ({ name: f.name, data: f.blob })) }, IN);
  FS.chdir(IN);
  const top = [...new Set(req.files.map((f) => f.name.split('/')[0]))];
  const args = ['a', '-t7z', `-mx${req.level}`, '-bsp1', '-bb0', '-y', '-spd'];
  if (req.password) args.push(`-p${req.password}`, '-mhe=on');
  // -spd: no wildcard matching; "--": everything after it is a file name, never a switch.
  const rc = run([...args, `${JOB}/out.7z`, '--', ...top]);
  if (rc !== 0) return explain();
  const data = FS.readFile(`${JOB}/out.7z`).buffer as ArrayBuffer;
  return { type: 'created', data };
}

self.onmessage = async (e: MessageEvent<SzRequest>) => {
  let res: SzResponse;
  try {
    await load();
    res = e.data.op === 'create' ? await create(e.data) : await extract(e.data);
  } catch (err) {
    res = fail('failed', `7-Zip stopped unexpectedly: ${(err as Error).message ?? err}`);
  }
  try {
    cleanup();
  } catch {
    // A broken FS state is discarded with the worker by the page.
  }
  post(res, res.type === 'created' ? [res.data] : res.type === 'extracted' ? res.entries.map((x) => x.data) : []);
};
