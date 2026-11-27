// Page side of the 7-Zip worker: one job at a time, cancel by terminating the worker.
// The worker (and its ~1.6 MB WASM) is created on first use only.
import type { ArchiveFile } from './archive';

export type SzRequest =
  | { op: 'create'; format: '7z' | 'zip'; files: ArchiveFile[]; level: 0 | 1 | 5 | 6 | 9; password?: string }
  | { op: 'extract'; name: string; blob: Blob; password?: string; maxBytes: number; maxEntries: number };

export interface SzFailure {
  type: 'error';
  code: 'password' | 'wrong-password' | 'too-big' | 'too-many' | 'failed';
  message: string;
}

export type SzResponse =
  | { type: 'progress'; fraction: number }
  | { type: 'created'; data: ArrayBuffer }
  | { type: 'extracted'; entries: { name: string; data: ArrayBuffer }[]; skipped: number; warning?: string }
  | SzFailure;

export type SzResult = Exclude<SzResponse, { type: 'progress' }>;

let worker: Worker | undefined;

export function runSevenZip(req: SzRequest, opts: { signal: AbortSignal; onProgress: (fraction: number) => void }): Promise<SzResult> {
  const { promise, resolve, reject } = Promise.withResolvers<SzResult>();
  if (opts.signal.aborted) {
    reject(new DOMException('Cancelled', 'AbortError'));
    return promise;
  }
  const w = (worker ??= new Worker(new URL('./sevenzip.worker.ts', import.meta.url), { type: 'module' }));
  const stop = () => {
    w.terminate();
    if (worker === w) worker = undefined;
  };
  const onAbort = () => {
    stop();
    reject(new DOMException('Cancelled', 'AbortError'));
  };
  opts.signal.addEventListener('abort', onAbort, { once: true });
  w.onmessage = (e: MessageEvent<SzResponse>) => {
    if (e.data.type === 'progress') return opts.onProgress(e.data.fraction);
    opts.signal.removeEventListener('abort', onAbort);
    // A job that failed may leave 7-Zip's in-memory file system in a bad state: start fresh next time.
    if (e.data.type === 'error') stop();
    resolve(e.data);
  };
  w.onerror = (e) => {
    opts.signal.removeEventListener('abort', onAbort);
    stop();
    reject(new Error(e.message || 'The 7-Zip worker could not start.'));
  };
  w.postMessage(req);
  return promise;
}
