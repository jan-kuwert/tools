// Files app (src/pages/files/index.astro): a file list for many files and folders with sorting and manual order,
// bulk rename, ZIP / 7z / gzip creation and archive extraction. Everything runs in the browser.
import { Gunzip, Gzip, Unzip, UnzipInflate, zip, type Zippable } from 'fflate';
import { renameOne, splitExt, ymd, type RenameOpts } from './rename';
import { runSevenZip } from './sevenzip';
import { downloadBlob, el, formatBytes, setDial, sniff, throwIfAborted, UserError } from './tool';

type Sniffed = 'jpeg' | 'png' | 'webp' | 'pdf' | 'gzip' | 'zip' | '7z' | 'rar' | 'xz' | 'bz2' | 'tar' | 'iso' | 'cab' | 'unknown';
type Panel = 'rename' | 'archive';

interface Entry {
  id: number;
  file: File;
  /** Folder path from a folder drop or an extracted archive ('' at the top), without a trailing slash. */
  dir: string;
  sniffed: Sniffed;
}

const MB = 1024 * 1024;
const MAX_ZIP = 500 * MB;
const MAX_GZ_IN = 200 * MB;
const MAX_GZ_OUT = 500 * MB;
const MAX_ENTRIES = 10_000;
const TYPE_LABEL: Record<Exclude<Sniffed, 'unknown'>, string> = {
  jpeg: 'JPEG image', png: 'PNG image', webp: 'WebP image', pdf: 'PDF document', gzip: 'Gzip archive', zip: 'ZIP archive',
  '7z': '7z archive', rar: 'RAR archive', xz: 'xz archive', bz2: 'bzip2 archive', tar: 'tar archive', iso: 'ISO disc image', cab: 'Cabinet archive',
};
/** Kinds Extract handles: ZIP and plain gzip with fflate, the rest with 7-Zip. */
const ARCHIVES: Sniffed[] = ['zip', 'gzip', '7z', 'rar', 'xz', 'bz2', 'tar', 'iso', 'cab'];
const IMAGE_EXT = /^(jpe?g|png|webp|gif|avif|svg|bmp|heic|heif|tiff?|ico)$/;
const AUDIO_EXT = /^(mp3|wav|flac|ogg|oga|opus|m4a|aac|aiff?|wma)$/;
const CODE_EXT = /^([cm]?js|[jt]sx?|html?|css|scss|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|php|sh|xml|ya?ml|toml|md|sql)$/;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const plural = (n: number, word = 'file') => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
const pathOf = (e: Entry) => (e.dir ? `${e.dir}/` : '') + e.file.name;
const typeOf = (e: Entry) => {
  if (e.sniffed !== 'unknown') return TYPE_LABEL[e.sniffed];
  const ext = splitExt(e.file.name)[1];
  return ext ? `${ext.toUpperCase()} file` : 'File';
};
const iconOf = (e: Entry) => {
  const ext = splitExt(e.file.name)[1].toLowerCase();
  if (ARCHIVES.includes(e.sniffed)) return 'files';
  if (e.sniffed === 'pdf') return 'pdf';
  if (e.sniffed === 'jpeg' || e.sniffed === 'png' || e.sniffed === 'webp' || IMAGE_EXT.test(ext)) return 'images';
  if (AUDIO_EXT.test(ext)) return 'audio';
  if (ext === 'json') return 'braces';
  return CODE_EXT.test(ext) ? 'code' : 'doc';
};

const byName = (a: Entry, b: Entry) => collator.compare(pathOf(a), pathOf(b));
/** Sort orders of the Sort menu; "manual" (not listed) keeps the current order. */
const SORTS: Record<string, (a: Entry, b: Entry) => number> = {
  name: byName,
  'name-desc': (a, b) => byName(b, a),
  size: (a, b) => a.file.size - b.file.size,
  'size-desc': (a, b) => b.file.size - a.file.size,
  type: (a, b) => collator.compare(typeOf(a), typeOf(b)) || byName(a, b),
  date: (a, b) => a.file.lastModified - b.file.lastModified,
  'date-desc': (a, b) => b.file.lastModified - a.file.lastModified,
};

/** tool.ts sniff plus the archive formats 7-Zip handles (magic bytes, never the extension). Reads only a few bytes. */
async function sniffAll(blob: Blob): Promise<Sniffed> {
  const basic = await sniff(blob);
  if (basic !== 'unknown') return basic;
  const b = new Uint8Array(await blob.slice(0, 262).arrayBuffer());
  const bytes = (o: number, xs: number[]) => xs.every((x, i) => b[o + i] === x);
  const ascii = (o: number, s: string) => bytes(o, [...s].map((c) => c.charCodeAt(0)));
  if (bytes(0, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return '7z';
  if (bytes(0, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07])) return 'rar';
  if (bytes(0, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])) return 'xz';
  if (ascii(0, 'BZh') && b[3] >= 0x31 && b[3] <= 0x39) return 'bz2';
  if (ascii(257, 'ustar')) return 'tar';
  if (ascii(0, 'MSCF')) return 'cab';
  if (blob.size >= 32774 && (await blob.slice(32769, 32774).text()) === 'CD001') return 'iso';
  return 'unknown';
}

/** Path made safe: no absolute paths, drive letters, `.`/`..` segments or control characters. */
const safeEntryName = (raw: string) =>
  raw
    .replace(/[\u0000-\u001f]/g, '')
    .split(/[\\/]+/)
    .filter((s) => s && s !== '.' && s !== '..' && !/^[a-z]:$/i.test(s))
    .join('/');

/**
 * True when a ZIP's central directory lists encrypted entries or methods other than store/deflate:
 * fflate cannot read those correctly, 7-Zip can. ZIP64 or unreadable directories stay with fflate.
 */
async function zipNeedsSevenZip(blob: Blob): Promise<boolean> {
  const tail = new DataView(await blob.slice(Math.max(0, blob.size - 65557)).arrayBuffer());
  let end = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) return false;
  const count = tail.getUint16(end + 10, true);
  const size = tail.getUint32(end + 12, true);
  const offset = tail.getUint32(end + 16, true);
  if (count === 0xffff || offset === 0xffffffff) return false;
  const cd = new DataView(await blob.slice(offset, offset + size).arrayBuffer());
  for (let p = 0, n = 0; n < count && p + 46 <= cd.byteLength; n++) {
    if (cd.getUint32(p, true) !== 0x02014b50) return false;
    const method = cd.getUint16(p + 10, true);
    if (cd.getUint16(p + 8, true) & 1 || (method !== 0 && method !== 8)) return true;
    p += 46 + cd.getUint16(p + 28, true) + cd.getUint16(p + 30, true) + cd.getUint16(p + 32, true);
  }
  return false;
}

/** Files below a dropped folder, keeping their relative folder path. */
async function walkEntry(entry: FileSystemEntry, out: { file: File; dir: string }[]): Promise<void> {
  if (entry.isFile) {
    const { promise, resolve, reject } = Promise.withResolvers<File>();
    (entry as FileSystemFileEntry).file(resolve, reject);
    const file = await promise;
    out.push({ file, dir: entry.fullPath.split('/').slice(0, -1).join('/') });
  } else if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // readEntries returns batches (about 100 in Chrome) until an empty one.
    for (;;) {
      const { promise, resolve, reject } = Promise.withResolvers<FileSystemEntry[]>();
      reader.readEntries(resolve, reject);
      const batch = await promise;
      if (!batch.length) break;
      for (const child of batch) await walkEntry(child, out);
    }
  }
}

export function initFilesApp(): void {
  const root = document.querySelector<HTMLElement>('[data-fl]')!;
  const $ = <T extends HTMLElement = HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  const $$ = <T extends HTMLElement = HTMLElement>(sel: string) => [...root.querySelectorAll<T>(sel)];
  const icons = $<HTMLTemplateElement>('[data-icons]');
  const icon = (name: string) => icons.content.querySelector(`[data-i="${name}"]`)!.firstElementChild!.cloneNode(true);
  const input = $<HTMLInputElement>('[data-input]');
  const folderInput = $<HTMLInputElement>('[data-folder-input]');
  const scroller = $('[data-scroll]');
  const table = $('[data-table]');
  const rows = $<HTMLTableSectionElement>('[data-rows]');
  const selectAll = $<HTMLInputElement>('[data-select-all]');
  const sortSel = $<HTMLSelectElement>('[data-sort]');
  const inspector = $('[data-inspector]');
  const renameForm = $<HTMLFormElement>('[data-rename]');
  const archiveForm = $<HTMLFormElement>('[data-archive]');
  const busyEl = $('[data-busy]');
  const dial = $('[data-dial]');
  const msg = $('[data-msg]');
  const narrow = matchMedia('(max-width: 760px)');
  folderInput.webkitdirectory = true;

  let entries: Entry[] = [];
  const selected = new Set<number>();
  let nextId = 1;
  let panel: Panel | null = null;
  let busy: AbortController | null = null;
  /** Previous File objects of the last applied rename. */
  let lastRename: Map<number, File> | undefined;
  /** Pending new names of the rename preview; empty while it is invalid. */
  let preview = new Map<number, string>();
  const rowRefs = new Map<number, { tr: HTMLTableRowElement; check: HTMLInputElement; next: HTMLTableCellElement }>();

  const byId = (id: number) => entries.find((e) => e.id === id);
  /** Files the rename and archive actions use: the selection, or every file when nothing is selected. */
  const scope = () => (selected.size ? entries.filter((e) => selected.has(e.id)) : entries);
  const isArchive = (e: Entry) => ARCHIVES.includes(e.sniffed);
  const checked = (form: HTMLFormElement, name: string) => form.querySelector<HTMLInputElement>(`[name="${name}"]:checked`)!.value;
  const field = <T extends HTMLInputElement | HTMLSelectElement = HTMLInputElement>(form: HTMLFormElement, name: string) => form.elements.namedItem(name) as T;

  function say(text: string, kind: 'info' | 'ok' | 'error' = 'info') {
    msg.textContent = text;
    msg.dataset.kind = kind;
  }

  function fail(err: unknown) {
    if (err instanceof DOMException && err.name === 'AbortError') return say('Cancelled.');
    if (!(err instanceof UserError)) console.error(err);
    say(err instanceof UserError ? err.message : `Something went wrong: ${(err as Error).message ?? err}`, 'error');
  }

  // ---- List ----
  function applySort() {
    const cmp = SORTS[sortSel.value];
    if (cmp) entries.sort(cmp);
  }

  function row(e: Entry): HTMLTableRowElement {
    const check = el('input', { type: 'checkbox', checked: selected.has(e.id), ariaLabel: `Select ${pathOf(e)}` });
    const grip = el('button', { type: 'button', className: 'fl-ib fl-grip', ariaLabel: `Reorder ${e.file.name}`, title: 'Drag to reorder (Alt+↑ / Alt+↓)' }, icon('reverse'));
    grip.setAttribute('aria-describedby', 'fl-order-help');
    const name = el('span', { className: 'fl-nm' }, ...(e.dir ? [el('span', { className: 'fl-dir', textContent: `${e.dir}/` })] : []), e.file.name);
    const next = el('td', { className: 'fl-c-new' });
    const tr = el(
      'tr',
      {},
      el('td', { className: 'fl-c-check' }, check),
      el('td', { className: 'fl-c-grip' }, grip),
      el('td', { className: 'fl-c-name', title: pathOf(e) }, el('span', { className: 'fl-name' }, icon(iconOf(e)), name)),
      next,
      el('td', { className: 'fl-c-type', textContent: typeOf(e) }),
      el('td', { className: 'fl-c-size', textContent: formatBytes(e.file.size) }),
      el('td', { className: 'fl-c-date', textContent: dateFmt.format(e.file.lastModified) }),
      el(
        'td',
        { className: 'fl-c-acts' },
        el('button', { type: 'button', className: 'fl-ib fl-dl', ariaLabel: `Download ${e.file.name}`, title: 'Download' }, icon('download')),
        el('button', { type: 'button', className: 'fl-ib fl-rm', ariaLabel: `Remove ${e.file.name} from the list`, title: 'Remove from the list' }, icon('xmark')),
      ),
    );
    tr.dataset.id = String(e.id);
    tr.dataset.kind = iconOf(e);
    if (selected.has(e.id)) tr.dataset.selected = '';
    rowRefs.set(e.id, { tr, check, next });
    return tr;
  }

  function renderList() {
    rowRefs.clear();
    rows.replaceChildren(...entries.map(row));
    table.hidden = !entries.length;
    $('[data-empty]').hidden = !!entries.length;
    renderChrome();
  }

  /** Everything that depends on the selection or the list, without rebuilding the rows. */
  function renderChrome() {
    const n = entries.length;
    const total = entries.reduce((s, e) => s + e.file.size, 0);
    selectAll.checked = n > 0 && selected.size === n;
    selectAll.indeterminate = selected.size > 0 && selected.size < n;
    selectAll.disabled = !n;
    $('[data-count]').textContent = n ? `${plural(n)} · ${formatBytes(total)}${selected.size ? ` · ${selected.size.toLocaleString()} selected` : ''}` : '';
    $<HTMLButtonElement>('[data-remove]').disabled = !selected.size;
    $<HTMLButtonElement>('[data-clear]').disabled = !n;
    $<HTMLButtonElement>('[data-download-all]').disabled = !n;
    const list = scope();
    const size = list.reduce((s, e) => s + e.file.size, 0);
    const scopeText = !n ? 'Add files first.' : selected.size ? `${plural(list.length)} selected · ${formatBytes(size)}` : `All ${plural(n)} · ${formatBytes(size)}`;
    $$('[data-scope]').forEach((s) => (s.textContent = scopeText));
    renderArchive();
    renderPreview();
  }

  function setSelected(id: number, on: boolean) {
    if (on) selected.add(id);
    else selected.delete(id);
    const ref = rowRefs.get(id);
    if (!ref) return;
    ref.check.checked = on;
    ref.tr.toggleAttribute('data-selected', on);
  }

  async function addFiles(list: { file: File; dir: string }[]) {
    const added = await Promise.all(list.map(async ({ file, dir }) => ({ id: nextId++, file, dir: safeEntryName(dir), sniffed: await sniffAll(file) })));
    entries.push(...added);
    applySort();
    renderList();
    return added.length;
  }

  async function addAndSay(list: { file: File; dir: string }[]) {
    if (!list.length) return;
    try {
      say(`Added ${plural(await addFiles(list))}.`);
    } catch (err) {
      fail(err);
    }
  }

  function remove(ids: number[]) {
    const gone = new Set(ids);
    entries = entries.filter((e) => !gone.has(e.id));
    ids.forEach((id) => selected.delete(id));
    renderList();
    say(`Removed ${plural(ids.length)}.`);
  }

  function confirmAsk(text: string, ok: string): Promise<boolean> {
    const dlg = $<HTMLDialogElement>('[data-confirm]');
    $('[data-confirm-text]').textContent = text;
    $('[data-confirm-ok]').textContent = ok;
    dlg.returnValue = '';
    const { promise, resolve } = Promise.withResolvers<boolean>();
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
    dlg.showModal();
    return promise;
  }

  /** Move `id` by `step` positions; the order becomes manual. */
  function move(id: number, step: number) {
    const i = entries.findIndex((e) => e.id === id);
    const j = i + step;
    if (i < 0 || j < 0 || j >= entries.length) return false;
    const [e] = entries.splice(i, 1);
    entries.splice(j, 0, e);
    sortSel.value = 'manual';
    say(`${e.file.name}: position ${j + 1} of ${entries.length}.`);
    return true;
  }

  // ---- Bulk rename ----
  function renameOpts(): RenameOpts | string {
    const f = renameForm;
    const o: RenameOpts = {
      template: field(f, 'template').value,
      start: Math.max(0, Math.floor(Number(field(f, 'start').value) || 0)),
      pad: Math.min(9, Math.max(1, Math.floor(Number(field(f, 'pad').value) || 1))),
      kase: field<HTMLSelectElement>(f, 'case').value as RenameOpts['kase'],
      spaces: field<HTMLSelectElement>(f, 'spaces').value as RenameOpts['spaces'],
      find: field(f, 'find').value,
      replace: field(f, 'replace').value,
      strip: field(f, 'strip').checked,
      keepExt: field(f, 'keepExt').checked,
      lowerExt: field(f, 'lowerExt').checked,
    };
    if (o.find && field(f, 'regex').checked) {
      try {
        o.re = new RegExp(o.find, 'g');
      } catch (err) {
        return `Invalid regular expression: ${(err as Error).message}`;
      }
    }
    return o;
  }

  function renderPreview() {
    field(renameForm, 'lowerExt').disabled = !field(renameForm, 'keepExt').checked;
    $<HTMLButtonElement>('[data-undo]').disabled = !lastRename || !!busy;
    if (panel !== 'rename') return;
    const targets = scope();
    const o = renameOpts();
    const error = $('[data-rename-error]');
    error.hidden = typeof o !== 'string';
    error.textContent = typeof o === 'string' ? o : '';
    const names = new Map<number, string>();
    if (typeof o !== 'string') {
      const today = ymd(Date.now());
      targets.forEach((e, i) => names.set(e.id, renameOne({ name: e.file.name, lastModified: e.file.lastModified, size: formatBytes(e.file.size) }, i, o, today)));
    }
    // Case-insensitive: most file systems (and unzip on them) treat "A.txt" and "a.txt" as the same file.
    const key = (e: Entry) => `${e.dir}/${names.get(e.id) ?? e.file.name}`.toLocaleLowerCase();
    const counts = new Map<string, number>();
    for (const e of entries) counts.set(key(e), (counts.get(key(e)) ?? 0) + 1);
    let changed = 0;
    let dupes = 0;
    let bad = 0;
    for (const e of entries) {
      const ref = rowRefs.get(e.id)!;
      const name = names.get(e.id);
      let problem = '';
      if (name !== undefined && name !== e.file.name) {
        changed++;
        if (!name || name === '.' || name === '..') problem = 'Empty name';
        else if (/[\\/\u0000-\u001f]/.test(name)) problem = 'Names cannot contain / or \\';
        else if (counts.get(key(e))! > 1) problem = 'Duplicate name';
        if (problem === 'Duplicate name') dupes++;
        else if (problem) bad++;
      }
      ref.next.textContent = name ?? '';
      ref.next.title = problem;
      ref.next.dataset.state = name === undefined ? 'off' : problem ? 'error' : name !== e.file.name ? 'changed' : 'same';
      if (problem) ref.next.append(el('span', { className: 'fl-problem', textContent: ` (${problem})` }));
    }
    preview = typeof o === 'string' || dupes || bad ? new Map() : names;
    const parts = [targets.length ? `${changed.toLocaleString()} of ${plural(targets.length, 'name')} change` : 'No files to rename.'];
    if (dupes) parts.push(`${plural(dupes, 'duplicate name')}`);
    if (bad) parts.push(`${plural(bad, 'invalid name')}`);
    $('[data-rename-summary]').textContent = parts.join(' · ');
    $('[data-rename-summary]').dataset.kind = dupes || bad ? 'error' : '';
    $<HTMLButtonElement>('[data-apply]').disabled = !!busy || !changed || !preview.size;
  }

  function applyRename() {
    if (busy || !preview.size) return;
    const undo = new Map<number, File>();
    for (const e of entries) {
      const name = preview.get(e.id);
      if (name === undefined || name === e.file.name) continue;
      undo.set(e.id, e.file);
      e.file = new File([e.file], name, { type: e.file.type, lastModified: e.file.lastModified });
    }
    if (!undo.size) return;
    lastRename = undo;
    // The template and find/replace would apply again on top of the new names; case and spacing rules are idempotent.
    field(renameForm, 'template').value = '{name}';
    field(renameForm, 'find').value = '';
    field(renameForm, 'replace').value = '';
    applySort();
    renderList();
    say(`Renamed ${plural(undo.size)}.`, 'ok');
  }

  function undoRename() {
    if (!lastRename || busy) return;
    let n = 0;
    for (const [id, file] of lastRename) {
      const e = byId(id);
      if (e) {
        e.file = file;
        n++;
      }
    }
    lastRename = undefined;
    applySort();
    renderList();
    say(`Restored ${plural(n, 'name')}.`);
  }

  // ---- Archives ----
  function renderArchive() {
    const list = scope();
    const fmt = checked(archiveForm, 'fmt');
    $('[data-levels="zip"]').hidden = fmt !== 'zip';
    $('[data-levels="7z"]').hidden = fmt !== '7z';
    $$('[data-fmt-pass]').forEach((n) => (n.hidden = fmt === 'gz'));
    $('[data-fmt-name]').hidden = fmt === 'gz';
    $('[data-ext]').textContent = fmt === '7z' ? '.7z' : '.zip';
    const create = $<HTMLButtonElement>('[data-create]');
    create.textContent = fmt === '7z' ? 'Create 7z' : fmt === 'gz' ? 'Gzip file' : 'Create ZIP';
    create.disabled = !!busy || !list.length || (fmt === 'gz' && list.length !== 1);
    create.title = fmt === 'gz' && list.length > 1 ? 'Gzip compresses a single file: select exactly one.' : '';
    const archives = list.filter(isArchive).length;
    const extract = $<HTMLButtonElement>('[data-extract]');
    extract.disabled = !!busy || !archives;
    extract.textContent = archives ? `Extract ${plural(archives, 'archive')}` : 'Extract archives';
    // Only archives in scope: extracting is the likely intent.
    const preferExtract = archives > 0 && archives === list.length;
    extract.classList.toggle('fl-primary', preferExtract);
    create.classList.toggle('fl-primary', !preferExtract);
  }

  const archiveName = (ext: string) => (field(archiveForm, 'zipName').value.trim().replace(/[\\/]+/g, '-') || 'archive').replace(/\.(zip|7z)$/i, '') + ext;

  /** Entry names in list order: folder paths kept, duplicates get " (2)". */
  function archiveFiles(list: Entry[]) {
    const used = new Set<string>();
    return list.map((e, i) => {
      const base = safeEntryName(pathOf(e)) || `file-${i + 1}`;
      let name = base;
      for (let k = 2; used.has(name); k++) name = base.replace(/(\.[^./]*)?$/, ` (${k})$1`);
      used.add(name);
      return { name, blob: e.file as Blob, mtime: e.file.lastModified };
    });
  }

  function setBusyText(text: string) {
    say(text);
    $('[data-busy-text]').textContent = text;
  }
  const setFraction = (f?: number) => setDial(dial, f);

  /** Runs one job under the progress overlay; Cancel aborts `signal`. */
  async function run(label: string, fn: (signal: AbortSignal) => Promise<void>) {
    if (busy) return;
    const ctl = new AbortController();
    busy = ctl;
    const back = document.activeElement as HTMLElement | null;
    const behind = [$('[data-top]'), $('[data-body]')];
    behind.forEach((n) => (n.inert = true));
    busyEl.hidden = false;
    dial.hidden = false;
    setDial(dial);
    setBusyText(label);
    renderChrome();
    $('[data-cancel]').focus();
    try {
      await fn(ctl.signal);
    } catch (err) {
      fail(err);
    } finally {
      busy = null;
      busyEl.hidden = true;
      behind.forEach((n) => (n.inert = false));
      renderChrome();
      back?.focus();
    }
  }

  async function makeArchive(fmt: 'zip' | '7z', list: Entry[], name: string, level: 0 | 1 | 5 | 6 | 9, password: string, signal: AbortSignal) {
    if (!list.length) throw new UserError('Add files first.');
    const total = list.reduce((s, e) => s + e.file.size, 0);
    if (total > MAX_ZIP) throw new UserError(`The files add up to ${formatBytes(total)}; the archive limit is ${formatBytes(MAX_ZIP)}.`);
    const files = archiveFiles(list);
    let blob: Blob;
    if (fmt === 'zip' && !password) {
      const zipped: Zippable = {};
      for (const [i, f] of files.entries()) {
        throwIfAborted(signal);
        setFraction(i / files.length);
        zipped[f.name] = [new Uint8Array(await f.blob.arrayBuffer()), { level, mtime: f.mtime }];
      }
      setBusyText('Compressing…');
      setFraction();
      const { promise, resolve, reject } = Promise.withResolvers<Uint8Array>();
      // Async fflate runs in workers and keeps the page responsive.
      const terminate = zip(zipped, (err, data) => (err ? reject(err) : resolve(data)));
      signal.addEventListener('abort', () => {
        terminate();
        reject(new DOMException('Cancelled', 'AbortError'));
      });
      blob = new Blob([(await promise) as BlobPart], { type: 'application/zip' });
    } else {
      // 7z, and ZIP with AES encryption (fflate cannot encrypt).
      setBusyText('Compressing with 7-Zip…');
      const res = await runSevenZip({ op: 'create', format: fmt, files, level, password: password || undefined }, { signal, onProgress: setFraction });
      if (res.type === 'error') throw new UserError(`Could not create ${name}: ${res.message}`);
      if (res.type !== 'created') throw new Error(`Unexpected 7-Zip reply: ${res.type}`);
      blob = new Blob([res.data], { type: fmt === '7z' ? 'application/x-7z-compressed' : 'application/zip' });
    }
    downloadBlob(blob, name);
    say(`Created ${name}${password ? ' (encrypted)' : ''} from ${plural(list.length)}: ${formatBytes(total)} → ${formatBytes(blob.size)}.`, 'ok');
  }

  /** Streams a file through gzip or gunzip. */
  async function gzipBlob(e: Entry, compress: boolean, signal: AbortSignal): Promise<Blob> {
    const src = e.file;
    if (src.size > MAX_GZ_IN) throw new UserError(`${src.name} is larger than ${formatBytes(MAX_GZ_IN)}, the gzip limit.`);
    const chunks: Uint8Array[] = [];
    let outSize = 0;
    const ondata = (chunk: Uint8Array) => {
      outSize += chunk.length;
      if (outSize > MAX_GZ_OUT) throw new UserError(`${src.name} decompresses to more than ${formatBytes(MAX_GZ_OUT)}; stopped to protect your device.`);
      chunks.push(chunk);
    };
    const stream = compress ? new Gzip({ mtime: src.lastModified }, ondata) : new Gunzip(ondata);
    const reader = src.stream().getReader();
    let read = 0;
    try {
      for (;;) {
        throwIfAborted(signal);
        const { done, value } = await reader.read();
        if (done) break;
        read += value.length;
        stream.push(value);
        setFraction(read / src.size);
      }
      stream.push(new Uint8Array(0), true);
    } catch (err) {
      reader.cancel().catch(() => {});
      if (err instanceof UserError || (err instanceof DOMException && err.name === 'AbortError')) throw err;
      // fflate throws plain errors for corrupt or truncated input.
      if (!compress) throw new UserError(`The gzip data in ${src.name} is damaged or incomplete.`);
      throw err;
    }
    return new Blob(chunks as BlobPart[], { type: compress ? 'application/gzip' : 'application/octet-stream' });
  }

  async function create(signal: AbortSignal) {
    const list = scope();
    const fmt = checked(archiveForm, 'fmt');
    if (fmt === 'gz') {
      if (list.length !== 1) throw new UserError('Gzip compresses a single file: select exactly one.');
      const blob = await gzipBlob(list[0], true, signal);
      const name = `${list[0].file.name}.gz`;
      downloadBlob(blob, name);
      return say(`Compressed ${list[0].file.name} → ${name}: ${formatBytes(list[0].file.size)} → ${formatBytes(blob.size)}.`, 'ok');
    }
    const level = Number(checked(archiveForm, fmt === '7z' ? 'level7' : 'level')) as 0 | 1 | 5 | 6 | 9;
    await makeArchive(fmt as 'zip' | '7z', list, archiveName(fmt === '7z' ? '.7z' : '.zip'), level, field(archiveForm, 'zipPass').value, signal);
  }

  /** Folder the archive's files go to: next to it, named after it, unique in the list. */
  function folderFor(a: Entry) {
    const stem = a.file.name.replace(/\.(tar\.[^.]+|[^.]+)$/i, '') || a.file.name;
    const parent = a.dir ? `${a.dir}/` : '';
    let dir = parent + stem;
    for (let n = 2; entries.some((x) => x.dir === dir || x.dir.startsWith(`${dir}/`)); n++) dir = `${parent}${stem} (${n})`;
    return dir;
  }

  const addExtracted = (a: Entry, files: { path: string; blob: Blob }[]) => {
    const base = folderFor(a);
    const now = Date.now();
    return addFiles(
      files.map(({ path, blob }) => {
        const i = path.lastIndexOf('/');
        return { file: new File([blob], path.slice(i + 1), { lastModified: now }), dir: i > 0 ? `${base}/${path.slice(0, i)}` : base };
      }),
    );
  };

  /** Plain .gz: the decompressed file goes next to the archive. */
  async function gunzip(a: Entry, signal: AbortSignal, notes: string[]) {
    const blob = await gzipBlob(a, false, signal);
    const base = a.file.name.replace(/\.tgz$/i, '.tar').replace(/\.gz$/i, '') || 'decompressed';
    let name = base;
    for (let k = 2; entries.some((x) => x.dir === a.dir && x.file.name === name); k++) name = base.replace(/(\.[^./]*)?$/, ` (${k})$1`);
    await addFiles([{ file: new File([blob], name, { lastModified: Date.now() }), dir: a.dir }]);
    notes.push(`Decompressed ${a.file.name} → ${name}: ${formatBytes(a.file.size)} → ${formatBytes(blob.size)}.`);
  }

  /** Extracts every file entry of a ZIP, with entry-count and expanded-size guards. */
  async function unzipEntry(a: Entry, signal: AbortSignal, notes: string[]) {
    const src = a.file;
    if (src.size > MAX_ZIP) throw new UserError(`${src.name} is larger than ${formatBytes(MAX_ZIP)}, the ZIP limit.`);
    if (await zipNeedsSevenZip(src)) return extract7z(a, signal, notes);
    const found: { name: string; chunks: Uint8Array[]; done: boolean; error?: string }[] = [];
    let total = 0;
    let renamed = 0;
    // fflate routes exceptions thrown in its callbacks back into ondata, so guards set `stop` and the push loop throws it.
    let stop: UserError | undefined;
    // Streaming: sizes are counted from the actual output, not trusted from the headers.
    const uz = new Unzip((file) => {
      // Folder entries and macOS resource-fork copies are skipped.
      if (stop || /[\\/]$/.test(file.name) || /^__MACOSX[\\/]/.test(file.name)) return;
      const name = safeEntryName(file.name);
      if (name !== file.name) renamed++;
      if (!name) return;
      if (found.length >= MAX_ENTRIES) return void (stop = new UserError(`${src.name} holds more than ${plural(MAX_ENTRIES)}; stopped to protect your device.`));
      const entry: (typeof found)[number] = { name, chunks: [], done: false };
      found.push(entry);
      file.ondata = (err, chunk, final) => {
        if (stop) return;
        if (err) return void (entry.error = err.message);
        total += chunk.length;
        if (total > MAX_ZIP) return void (stop = new UserError(`${src.name} expands to more than ${formatBytes(MAX_ZIP)}; stopped to protect your device.`));
        entry.chunks.push(chunk);
        if (final) entry.done = true;
      };
      file.start();
    });
    uz.register(UnzipInflate);
    const reader = src.stream().getReader();
    let read = 0;
    try {
      for (;;) {
        throwIfAborted(signal);
        const { done, value } = await reader.read();
        if (done) break;
        // Small pushes bound how much one call can inflate before the size guard runs (deflate expands ≤ ~1032×).
        for (let o = 0; o < value.length && !stop; o += 65536) uz.push(value.subarray(o, o + 65536));
        if (stop) throw stop;
        read += value.length;
        setFraction(read / src.size);
      }
      uz.push(new Uint8Array(0), true);
      if (stop) throw stop;
    } catch (err) {
      reader.cancel().catch(() => {});
      if (err instanceof UserError || (err instanceof DOMException && err.name === 'AbortError')) throw err;
      // fflate stopped (e.g. ZIP64 quirks or damaged headers): 7-Zip is more forgiving.
      return extract7z(a, signal, notes);
    }
    const good = found.filter((e) => e.done && !e.error);
    // Encrypted entries or methods fflate lacks (Deflate64, LZMA, AES…): hand the whole archive to 7-Zip.
    if (good.length < found.length) return extract7z(a, signal, notes);
    if (!good.length) throw new UserError(`${src.name} contains no files.`);
    setBusyText('Adding files…');
    await addExtracted(a, good.map((e) => ({ path: e.name, blob: new Blob(e.chunks as BlobPart[]) })));
    notes.push(`Extracted ${plural(good.length)} from ${src.name}: ${formatBytes(src.size)} → ${formatBytes(total)}.`);
    if (renamed) notes.push(`${plural(renamed, 'entry name')} pointed outside the archive or used unsafe characters and ${renamed === 1 ? 'was' : 'were'} cleaned up.`);
  }

  async function extract7z(a: Entry, signal: AbortSignal, notes: string[]) {
    const src = a.file;
    if (src.size > MAX_ZIP) throw new UserError(`${src.name} is larger than ${formatBytes(MAX_ZIP)}, the archive limit.`);
    let password: string | undefined;
    for (;;) {
      setBusyText(`Extracting ${src.name}…`);
      setFraction();
      const res = await runSevenZip({ op: 'extract', name: src.name, blob: src, password, maxBytes: MAX_ZIP, maxEntries: MAX_ENTRIES }, { signal, onProgress: setFraction });
      if (res.type === 'error') {
        if (res.code === 'password' || res.code === 'wrong-password') {
          password = await askPassword(src.name, res.code === 'wrong-password' && password !== undefined);
          if (password === undefined) throw new DOMException('Cancelled', 'AbortError');
          continue;
        }
        if (res.code === 'too-big') throw new UserError(`${src.name} expands to more than ${formatBytes(MAX_ZIP)}; stopped to protect your device.`);
        if (res.code === 'too-many') throw new UserError(`${src.name} holds more than ${plural(MAX_ENTRIES)}; stopped to protect your device.`);
        throw new UserError(`${src.name}: ${res.message}`);
      }
      if (res.type !== 'extracted') throw new Error(`Unexpected 7-Zip reply: ${res.type}`);
      setBusyText('Adding files…');
      let renamed = 0;
      let total = 0;
      const files: { path: string; blob: Blob }[] = [];
      for (const e of res.entries) {
        const path = safeEntryName(e.name);
        if (path !== e.name) renamed++;
        if (!path) continue;
        total += e.data.byteLength;
        files.push({ path, blob: new Blob([e.data]) });
      }
      if (!files.length) throw new UserError(`${src.name} contains no files.`);
      await addExtracted(a, files);
      notes.push(`Extracted ${plural(files.length)} from ${src.name}: ${formatBytes(src.size)} → ${formatBytes(total)}.`);
      if (res.skipped) notes.push(`${plural(res.skipped, 'link')} or special file${res.skipped === 1 ? '' : 's'} ${res.skipped === 1 ? 'was' : 'were'} skipped.`);
      if (renamed) notes.push(`${plural(renamed, 'entry name')} used unsafe characters and ${renamed === 1 ? 'was' : 'were'} cleaned up.`);
      if (res.warning) notes.push(res.warning);
      return;
    }
  }

  async function extractAll(signal: AbortSignal) {
    const notes: string[] = [];
    for (const a of scope().filter(isArchive)) {
      if (a.sniffed === 'zip') await unzipEntry(a, signal, notes);
      // Plain .gz stays with fflate; a gzipped tar is unpacked in one go by 7-Zip.
      else if (a.sniffed === 'gzip' && !/\.(tgz|tar\.gz)$/i.test(a.file.name)) await gunzip(a, signal, notes);
      else await extract7z(a, signal, notes);
    }
    say(notes.join(' '), 'ok');
  }

  /** Modal password prompt; resolves undefined on cancel. The password is only handed to the worker for this job. */
  function askPassword(name: string, wrong: boolean): Promise<string | undefined> {
    const dlg = $<HTMLDialogElement>('[data-pw-dialog]');
    const pw = dlg.querySelector<HTMLInputElement>('input[name="pw"]')!;
    const err = $('[data-pw-error]');
    $('[data-pw-text]').textContent = `${name} is encrypted. Enter its password to extract it.`;
    err.textContent = wrong ? 'That password is wrong. Try again.' : '';
    err.hidden = !wrong;
    pw.value = '';
    dlg.returnValue = '';
    const { promise, resolve } = Promise.withResolvers<string | undefined>();
    dlg.addEventListener(
      'close',
      () => {
        resolve(dlg.returnValue === 'ok' ? pw.value : undefined);
        pw.value = '';
      },
      { once: true },
    );
    dlg.showModal();
    return promise;
  }

  // ---- Inspector ----
  /** Last tab shown, reopened by the top bar's toggle. */
  let lastPanel: Panel = 'rename';
  function showPanel(p: Panel | null) {
    panel = p;
    if (p) lastPanel = p;
    inspector.hidden = !p;
    $$('[data-panel]').forEach((s) => (s.hidden = s.dataset.panel !== p));
    $$('[data-panel-btn]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.panelBtn === p)));
    $('[data-toggle-inspector]').ariaExpanded = String(!!p);
    root.toggleAttribute('data-renaming', p === 'rename');
    renderChrome();
  }

  // ---- Wiring ----
  input.addEventListener('change', () => {
    const files = [...(input.files ?? [])];
    input.value = '';
    void addAndSay(files.map((file) => ({ file, dir: '' })));
  });
  folderInput.addEventListener('change', () => {
    const files = [...(folderInput.files ?? [])];
    folderInput.value = '';
    void addAndSay(files.map((file) => ({ file, dir: file.webkitRelativePath.split('/').slice(0, -1).join('/') })));
  });
  $$('[data-open]').forEach((b) => b.addEventListener('click', () => input.click()));
  $$('[data-open-folder]').forEach((b) => b.addEventListener('click', () => folderInput.click()));
  $('[data-remove]').addEventListener('click', async () => {
    const list = entries.filter((e) => selected.has(e.id));
    if (!list.length) return;
    if ((list.length > 3 || list.some((e) => e.dir)) && !(await confirmAsk(`Remove ${plural(list.length)} from the list? Files on your device are not touched.`, 'Remove'))) return;
    remove(list.map((e) => e.id));
  });
  $('[data-clear]').addEventListener('click', async () => {
    if (!entries.length || !(await confirmAsk(`Remove all ${plural(entries.length)} from the list? Files on your device are not touched.`, 'Clear all'))) return;
    remove(entries.map((e) => e.id));
    lastRename = undefined;
    renderChrome();
  });
  $('[data-download-all]').addEventListener('click', () =>
    run('Reading files…', (signal) => makeArchive('zip', entries, archiveName('.zip'), Number(checked(archiveForm, 'level')) as 0 | 6 | 9, '', signal)),
  );
  sortSel.addEventListener('change', () => {
    applySort();
    renderList();
  });
  selectAll.addEventListener('change', () => {
    entries.forEach((e) => setSelected(e.id, selectAll.checked));
    renderChrome();
  });
  $$('[data-panel-btn]').forEach((b) => b.addEventListener('click', () => showPanel(b.dataset.panelBtn as Panel)));
  $('[data-toggle-inspector]').addEventListener('click', () => showPanel(panel ? null : lastPanel));
  function closePanel() {
    showPanel(null);
    $('[data-toggle-inspector]').focus();
  }
  $$('[data-close-panel]').forEach((b) => b.addEventListener('click', closePanel));
  $('[data-cancel]').addEventListener('click', () => busy?.abort());
  $('[data-pw-cancel]').addEventListener('click', () => $<HTMLDialogElement>('[data-pw-dialog]').close('cancel'));

  rows.addEventListener('change', (e) => {
    const t = e.target as HTMLInputElement;
    const id = Number(t.closest('tr')?.dataset.id);
    if (t.type !== 'checkbox' || !id) return;
    setSelected(id, t.checked);
    renderChrome();
  });
  let dragged = false;
  rows.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const tr = t.closest('tr');
    if (!tr || dragged || busy) return;
    const it = byId(Number(tr.dataset.id));
    if (!it) return;
    if (t.closest('.fl-dl')) return downloadBlob(it.file, it.file.name);
    if (t.closest('.fl-rm')) {
      const nextId = Number((tr.nextElementSibling ?? tr.previousElementSibling)?.getAttribute('data-id'));
      remove([it.id]);
      return (rowRefs.get(nextId)?.tr.querySelector<HTMLElement>('.fl-rm') ?? $('[data-open]')).focus();
    }
    // Clicking the row (outside its controls) toggles the selection.
    if (t.closest('input, button, a')) return;
    setSelected(it.id, !selected.has(it.id));
    renderChrome();
  });
  rows.addEventListener('keydown', (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    const t = e.target as HTMLElement;
    const id = Number(t.closest('tr')?.dataset.id);
    if (!id) return;
    e.preventDefault();
    if (!move(id, e.key === 'ArrowUp' ? -1 : 1)) return;
    const sel = ['input', '.fl-grip', '.fl-dl', '.fl-rm'].find((s) => t.matches(s)) ?? '.fl-grip';
    renderList();
    const tr = rowRefs.get(id)!.tr;
    tr.querySelector<HTMLElement>(sel)?.focus();
    tr.scrollIntoView({ block: 'nearest' });
  });

  // Pointer reordering: mouse from anywhere on the row, touch and pen from the grip only (so the list still scrolls).
  let drag: { tr: HTMLTableRowElement; y: number; moved: boolean } | undefined;
  rows.addEventListener('pointerdown', (e) => {
    const t = e.target as HTMLElement;
    const tr = t.closest('tr');
    const onGrip = !!t.closest('.fl-grip');
    if (!tr || e.button !== 0 || busy || (!onGrip && (e.pointerType !== 'mouse' || t.closest('input, button, a')))) return;
    drag = { tr, y: e.clientY, moved: false };
  });
  rows.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (!drag.moved) {
      if (Math.abs(e.clientY - drag.y) < 5) return;
      drag.moved = true;
      drag.tr.classList.add('fl-dragging');
      // Captured only once a drag starts, so a plain click still reaches the row.
      rows.setPointerCapture(e.pointerId);
    }
    const box = scroller.getBoundingClientRect();
    if (e.clientY < box.top + 48) scroller.scrollTop -= 14;
    else if (e.clientY > box.bottom - 24) scroller.scrollTop += 14;
    const over = document.elementFromPoint(box.left + 8, e.clientY)?.closest('tr');
    if (!over || over === drag.tr || over.parentElement !== rows) return;
    const r = over.getBoundingClientRect();
    rows.insertBefore(drag.tr, e.clientY < r.top + r.height / 2 ? over : over.nextSibling);
  });
  const endDrag = () => {
    const d = drag;
    drag = undefined;
    if (!d?.moved) return;
    d.tr.classList.remove('fl-dragging');
    dragged = true;
    setTimeout(() => (dragged = false));
    const pos = new Map([...rows.rows].map((tr, i) => [Number(tr.dataset.id), i]));
    entries.sort((a, b) => pos.get(a.id)! - pos.get(b.id)!);
    sortSel.value = 'manual';
    const id = Number(d.tr.dataset.id);
    renderList();
    say(`${byId(id)!.file.name}: position ${pos.get(id)! + 1} of ${entries.length}.`);
  };
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);

  renameForm.addEventListener('input', renderPreview);
  renameForm.addEventListener('change', renderPreview);
  renameForm.addEventListener('submit', (e) => {
    e.preventDefault();
    applyRename();
  });
  $('[data-undo]').addEventListener('click', undoRename);
  $$('[data-var]').forEach((b) =>
    b.addEventListener('click', () => {
      const t = field(renameForm, 'template');
      t.setRangeText(b.dataset.var!, t.selectionStart ?? t.value.length, t.selectionEnd ?? t.value.length, 'end');
      t.focus();
      renderPreview();
    }),
  );
  archiveForm.addEventListener('change', renderArchive);
  archiveForm.addEventListener('submit', (e) => {
    e.preventDefault();
    void run('Reading files…', create);
  });
  $('[data-extract]').addEventListener('click', () => run('Extracting…', extractAll));

  // Drops anywhere on the app; folders are walked recursively with their relative paths.
  root.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types.includes('Files') || busy) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    root.classList.add('fl-over');
  });
  root.addEventListener('dragleave', (e) => {
    if (!root.contains(e.relatedTarget as Node | null)) root.classList.remove('fl-over');
  });
  root.addEventListener('drop', async (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    root.classList.remove('fl-over');
    if (busy) return;
    // Entries and files must be taken synchronously: the DataTransfer is emptied after this handler yields.
    const items = [...e.dataTransfer.items].filter((i) => i.kind === 'file');
    const roots = items.map((i) => i.webkitGetAsEntry());
    const plain = items.map((i) => i.getAsFile());
    const list: { file: File; dir: string }[] = [];
    try {
      for (const [i, entry] of roots.entries()) {
        const file = plain[i];
        if (entry) await walkEntry(entry, list);
        else if (file) list.push({ file, dir: '' });
      }
    } catch (err) {
      return fail(err);
    }
    await addAndSay(list);
  });
  document.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files ?? [])];
    if (!files.length || busy) return;
    e.preventDefault();
    void addAndSay(files.map((file) => ({ file, dir: '' })));
  });
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && narrow.matches && panel && !busy && inspector.contains(e.target as Node)) closePanel();
  });

  // Deep links: archive modes preselect the format (or Extract); rename opens the rename panel.
  const mode = new URLSearchParams(location.search).get('mode');
  const fmt = ({ zip: 'zip', '7z': '7z', gzip: 'gz' } as Record<string, string | undefined>)[mode ?? ''];
  if (fmt) archiveForm.querySelector<HTMLInputElement>(`[name="fmt"][value="${fmt}"]`)!.checked = true;
  if (fmt || mode === 'extract') showPanel('archive');
  else showPanel(mode === 'rename' || !narrow.matches ? 'rename' : null);
  // The sidebar only collapses as a narrow-screen drawer; widening the window brings it back.
  narrow.addEventListener('change', () => {
    if (!narrow.matches && !panel) showPanel(lastPanel);
  });
  renderList();
}
