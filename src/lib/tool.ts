// Shared client runtime for file-based tools rendered by ToolShell.astro.

export interface Result {
  name: string;
  blob: Blob;
  /** Size of the corresponding input, to show the before/after delta. */
  inputSize?: number;
  note?: string;
  /** Show an inline preview (images/audio). */
  preview?: boolean;
}

export interface RunContext {
  signal: AbortSignal;
  /** fraction in [0,1] for real progress; omit for indeterminate. */
  progress(text: string, fraction?: number): void;
  form: HTMLFormElement;
}

export interface ToolOptions {
  /** Validate one file; return an error message to reject it. */
  validate?(file: File): string | undefined;
  /** Called after the file list changes (e.g. to render thumbnails). */
  onFilesChange?(files: File[]): void;
  run(files: File[], ctx: RunContext): Promise<Result[]>;
  /** Cloud tools: confirm upload before every run. */
  cloud?: boolean;
}

export class UserError extends Error {}

export const formatBytes = (n: number): string => {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
};

export const replaceExt = (name: string, ext: string): string => name.replace(/\.[^./]*$/, '') + '.' + ext;

export const downloadBlob = (blob: Blob, name: string): void => {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
};

/** Yield to the event loop so progress UI can paint during long loops. */
export const tick = (): Promise<void> => new Promise((r) => setTimeout(r));

/** Update a ProgressDial: a fraction in [0,1], or undefined for indeterminate. */
export function setDial(dial: HTMLElement, fraction?: number): void {
  const known = fraction !== undefined;
  const pct = known ? Math.round(Math.min(1, Math.max(0, fraction)) * 100) : 0;
  dial.classList.toggle('indeterminate', !known);
  dial.style.setProperty('--p', String(pct));
  dial.querySelector('.dial-value')!.textContent = known ? `${pct}%` : '';
  if (known) dial.ariaValueNow = String(pct);
  else dial.removeAttribute('aria-valuenow');
}

export const throwIfAborted = (signal: AbortSignal): void => {
  if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
};

export const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] => {
  const { class: cls, ...rest } = props;
  const node = Object.assign(document.createElement(tag), rest);
  if (cls) node.className = cls;
  node.append(...children);
  return node;
};

/** Wire up the ToolShell markup. Call once per page. */
export function createTool(opts: ToolOptions): { files: () => File[]; setFiles(files: File[]): void; showResults(items: Result[]): void; clearResults(): void } {
  const root = document.querySelector<HTMLElement>('[data-tool]')!;
  const input = root.querySelector<HTMLInputElement>('[data-input]')!;
  const drop = root.querySelector<HTMLElement>('[data-drop]')!;
  const list = root.querySelector<HTMLOListElement>('[data-files]')!;
  const form = root.querySelector<HTMLFormElement>('[data-options]')!;
  const runBtn = root.querySelector<HTMLButtonElement>('[data-run]')!;
  const cancelBtn = root.querySelector<HTMLButtonElement>('[data-cancel]')!;
  const clearBtn = root.querySelector<HTMLButtonElement>('[data-clear]')!;
  const status = root.querySelector<HTMLElement>('[data-status]')!;
  const dial = root.querySelector<HTMLElement>('[data-progress]')!;
  // Results panel is a sibling of the tool panel.
  const results = document.querySelector<HTMLElement>('[data-results]')!;
  const multiple = input.multiple;

  let files: File[] = [];
  let controller: AbortController | undefined;
  let urls: string[] = [];

  const setStatus = (kind: 'idle' | 'working' | 'done' | 'error', text = '', fraction?: number) => {
    status.dataset.kind = kind;
    status.textContent = text;
    dial.hidden = kind !== 'working';
    setDial(dial, fraction);
  };

  const clearResults = () => {
    urls.forEach((u) => URL.revokeObjectURL(u));
    urls = [];
    results.replaceChildren();
    results.hidden = true;
  };

  const renderFiles = () => {
    list.replaceChildren(
      ...files.map((f, i) => {
        const up = el('button', { type: 'button', className: 'icon-btn', title: 'Move up', ariaLabel: `Move ${f.name} up`, disabled: i === 0, textContent: '↑' });
        const down = el('button', { type: 'button', className: 'icon-btn', title: 'Move down', ariaLabel: `Move ${f.name} down`, disabled: i === files.length - 1, textContent: '↓' });
        const remove = el('button', { type: 'button', className: 'icon-btn', title: 'Remove', ariaLabel: `Remove ${f.name}`, textContent: '✕' });
        up.onclick = () => move(i, i - 1);
        down.onclick = () => move(i, i + 1);
        remove.onclick = () => setFiles(files.filter((_, j) => j !== i));
        const controls = multiple && files.length > 1 ? [up, down, remove] : [remove];
        return el('li', {}, el('span', { className: 'file-name', textContent: f.name }), el('span', { className: 'file-size', textContent: formatBytes(f.size) }), el('span', { className: 'file-actions' }, ...controls));
      }),
    );
    list.hidden = files.length === 0;
    runBtn.disabled = files.length === 0;
    clearBtn.hidden = files.length === 0;
    drop.classList.toggle('compact', files.length > 0);
    opts.onFilesChange?.(files);
  };

  const move = (from: number, to: number) => {
    const next = [...files];
    next.splice(to, 0, next.splice(from, 1)[0]);
    setFiles(next);
  };

  const setFiles = (next: File[]) => {
    files = next;
    clearResults();
    setStatus('idle');
    renderFiles();
  };

  const addFiles = (incoming: File[]) => {
    const errors: string[] = [];
    const accepted = incoming.filter((f) => {
      const err = opts.validate?.(f);
      if (err) errors.push(`${f.name}: ${err}`);
      return !err;
    });
    setFiles(multiple ? [...files, ...accepted] : accepted.slice(0, 1).concat(accepted.length ? [] : files));
    if (errors.length) setStatus('error', errors.join('\n'));
  };

  input.addEventListener('change', () => {
    addFiles([...(input.files ?? [])]);
    input.value = '';
  });
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    addFiles([...(e.dataTransfer?.files ?? [])]);
  });
  // Paste images/files directly from the clipboard.
  document.addEventListener('paste', (e) => {
    const pasted = [...(e.clipboardData?.files ?? [])];
    if (pasted.length && !(e.target instanceof HTMLTextAreaElement)) addFiles(pasted);
  });

  clearBtn.onclick = () => setFiles([]);
  cancelBtn.onclick = () => controller?.abort();
  form.addEventListener('submit', (e) => e.preventDefault());

  const renderResults = (items: Result[]) => {
    clearResults();
    const cards = items.map((r) => {
      const url = URL.createObjectURL(r.blob);
      urls.push(url);
      let delta = '';
      if (r.inputSize) {
        const pct = Math.round((r.blob.size / r.inputSize - 1) * 100);
        delta = pct === 0 ? ' · same size' : pct < 0 ? ` · ${-pct}% smaller` : ` · ${pct}% larger`;
      }
      const meta = el('p', { className: 'result-meta', textContent: `${formatBytes(r.blob.size)}${delta}` });
      // A note explains expected growth (e.g. WAV output); only flag unexplained growth.
      if (r.inputSize && r.blob.size > r.inputSize && !r.note) meta.classList.add('warn');
      const preview = !r.preview
        ? null
        : r.blob.type.startsWith('image/')
          ? el('img', { src: url, alt: `Preview of ${r.name}`, className: 'result-preview checker' })
          : r.blob.type.startsWith('audio/')
            ? el('audio', { src: url, controls: true, className: 'result-audio' })
            : null;
      return el(
        'li',
        { className: 'result' },
        ...(preview ? [preview] : []),
        el('div', { className: 'result-body' }, el('p', { className: 'result-name', textContent: r.name }), meta, ...(r.note ? [el('p', { className: 'result-note', textContent: r.note })] : [])),
        el('a', { className: 'btn btn-primary', href: url, download: r.name, textContent: 'Download' }),
      );
    });
    results.append(el('h2', { textContent: items.length === 1 ? 'Result' : `${items.length} results` }), el('ul', { className: 'result-list' }, ...cards));
    results.hidden = false;
    results.querySelector<HTMLElement>('a.btn')?.focus();
  };

  runBtn.onclick = async () => {
    if (!files.length) return;
    if (opts.cloud && !(await confirmUpload())) return;
    controller = new AbortController();
    clearResults();
    runBtn.disabled = true;
    cancelBtn.hidden = false;
    setStatus('working', 'Working…');
    try {
      const out = await opts.run(files, {
        signal: controller.signal,
        progress: (text, fraction) => setStatus('working', text, fraction),
        form,
      });
      setStatus('done', 'Done.');
      renderResults(out);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') setStatus('idle', 'Cancelled.');
      else {
        console.error(err);
        setStatus('error', err instanceof UserError ? err.message : `Something went wrong: ${(err as Error).message ?? err}`);
      }
    } finally {
      controller = undefined;
      runBtn.disabled = files.length === 0;
      cancelBtn.hidden = true;
    }
  };

  renderFiles();
  return { files: () => files, setFiles, showResults: renderResults, clearResults };
}

/** Ask before every upload via ToolShell's consent dialog; never remembered. Fails closed without the dialog. */
export function confirmUpload(): Promise<boolean> {
  const consent = document.querySelector<HTMLDialogElement>('[data-consent]');
  if (!consent) return Promise.resolve(false);
  const { promise, resolve } = Promise.withResolvers<boolean>();
  consent.returnValue = '';
  consent.showModal();
  consent.addEventListener('close', () => resolve(consent.returnValue === 'upload'), { once: true });
  return promise;
}

/** Basic magic-byte sniffing; never trust extension or MIME type alone. */
export async function sniff(file: Blob): Promise<'jpeg' | 'png' | 'webp' | 'pdf' | 'gzip' | 'zip' | 'unknown'> {
  const b = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const s = (o: number, str: string) => [...str].every((c, i) => b[o + i] === c.charCodeAt(0));
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b[0] === 0x89 && s(1, 'PNG')) return 'png';
  if (s(0, 'RIFF') && s(8, 'WEBP')) return 'webp';
  if (s(0, '%PDF')) return 'pdf';
  if (b[0] === 0x1f && b[1] === 0x8b) return 'gzip';
  if (s(0, 'PK')) return 'zip';
  return 'unknown';
}
