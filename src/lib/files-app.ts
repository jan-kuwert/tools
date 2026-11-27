// Files & text app (src/pages/files/index.astro): explorer, tabbed text editor, JSON/JS tools and an archive tray (ZIP/gzip).
import { Gunzip, Gzip, gzipSync, Unzip, UnzipInflate, zip, type Zippable } from 'fflate';
import { formatJson, jsonError } from './json';
import { jsonErrorAt } from './json-locate';
import type * as Highlight from './highlight';
import type * as Markdown from './markdown';
import { diffLines, diffWords, sortJsonKeys } from './diff';
import { resizable } from './resize';
import { runSevenZip } from './sevenzip';
import { downloadBlob, el, formatBytes, setDial, sniff, throwIfAborted, UserError } from './tool';

type Tool = 'json' | 'js' | 'zip' | 'gzip' | 'compare';
type Lang = 'json' | 'js' | 'text' | 'binary';
type Kind = 'info' | 'ok' | 'warn' | 'error';
type Sniffed = 'jpeg' | 'png' | 'webp' | 'pdf' | 'gzip' | 'zip' | '7z' | 'rar' | 'xz' | 'bz2' | 'tar' | 'iso' | 'cab' | 'unknown';

interface Item {
  id: number;
  name: string;
  /** Present for text documents (editable). */
  text?: string;
  /** Original bytes; used as-is for downloads and archives until the text is edited. */
  blob?: Blob;
  edited: boolean;
  size: number;
  sniffed: Sniffed;
  /** Outputs and untitled documents can be renamed. */
  generated: boolean;
  mtime: number;
  note?: string;
  json?: { ok: boolean; message?: string; line?: number; col?: number };
  view?: { start: number; end: number; dir: 'forward' | 'backward' | 'none'; top: number; left: number };
  /** Highlighting language chosen in the status bar; overrides detection. */
  syntax?: string;
  mdView?: 'edit' | 'split' | 'preview';
}

const MB = 1024 * 1024;
const MAX_TEXT = 50 * MB;
const WARN_TEXT = 5 * MB;
const MAX_JS = 10 * MB;
const MAX_ZIP = 500 * MB;
const MAX_GZ_IN = 200 * MB;
const MAX_GZ_OUT = 500 * MB;
const MAX_INLINE = 5 * MB;
const MAX_ENTRIES = 10_000;
const DRAG_TYPE = 'application/x-fx-items';
const LINE = 20; // px; matches --fx-line
const TOOLS: Tool[] = ['json', 'js', 'zip', 'gzip', 'compare'];
/** Tab id of the comparison view (items have positive ids). */
const DIFF = -1;
const INDENTS: Record<string, string> = { '2': '  ', '4': '    ', tab: '\t' };
const LANG_LABEL: Record<Lang, string> = { json: 'JSON', js: 'JavaScript', text: 'Plain text', binary: 'Binary' };
const TYPE_LABEL: Record<Item['sniffed'], string> = {
  jpeg: 'JPEG image', png: 'PNG image', webp: 'WebP image', pdf: 'PDF document', gzip: 'Gzip archive', zip: 'ZIP archive',
  '7z': '7z archive', rar: 'RAR archive', xz: 'xz archive', bz2: 'bzip2 archive', tar: 'tar archive', iso: 'ISO disc image', cab: 'Cabinet archive', unknown: 'Binary data',
};
/** Kinds the tray can extract: ZIP and plain gzip with fflate, the rest with 7-Zip. */
const ARCHIVES: Sniffed[] = ['zip', 'gzip', '7z', 'rar', 'xz', 'bz2', 'tar', 'iso', 'cab'];

/** tool.ts sniff plus the archive formats 7-Zip handles (magic bytes, never the extension). */
async function sniffAll(blob: Blob): Promise<Sniffed> {
  const basic = await sniff(blob);
  if (basic !== 'unknown') return basic;
  const b = new Uint8Array(await blob.slice(0, 32774).arrayBuffer());
  const bytes = (o: number, xs: number[]) => xs.every((x, i) => b[o + i] === x);
  const ascii = (o: number, s: string) => bytes(o, [...s].map((c) => c.charCodeAt(0)));
  if (bytes(0, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return '7z';
  if (bytes(0, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07])) return 'rar';
  if (bytes(0, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])) return 'xz';
  if (ascii(0, 'BZh') && b[3] >= 0x31 && b[3] <= 0x39) return 'bz2';
  if (ascii(257, 'ustar')) return 'tar';
  if (ascii(0, 'MSCF')) return 'cab';
  if (ascii(32769, 'CD001')) return 'iso';
  return 'unknown';
}

/** Archive entry path made safe for the Explorer: no absolute paths, drive letters, `.`/`..` segments or control characters. */
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

/** UTF-8 text without NUL bytes, or null for binary, non-UTF-8 or oversized data. */
async function decodeText(blob: Blob, max: number): Promise<string | null> {
  if (blob.size > max || (await sniff(blob)) !== 'unknown') return null;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.subarray(0, 8192).includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

const lang = (it: Item): Lang => {
  if (it.text === undefined) return 'binary';
  if (/\.json$/i.test(it.name)) return 'json';
  if (/\.[cm]?js$/i.test(it.name)) return 'js';
  // Untitled documents (no extension) that look like JSON.
  return !/\.[^./]+$/.test(it.name) && /^\s*[[{]/.test(it.text.slice(0, 256)) ? 'json' : 'text';
};

/** highlight.js language ids offered in the status bar. */
const SYNTAXES: Record<string, string> = {
  plaintext: 'Plain text', bash: 'Shell', css: 'CSS', xml: 'HTML / XML', javascript: 'JavaScript', json: 'JSON',
  markdown: 'Markdown', python: 'Python', sql: 'SQL', typescript: 'TypeScript', yaml: 'YAML',
};
const EXT_SYNTAX: Record<string, string> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  json: 'json', jsonc: 'json', webmanifest: 'json', geojson: 'json', py: 'python', pyw: 'python', md: 'markdown', markdown: 'markdown',
  html: 'xml', htm: 'xml', xhtml: 'xml', xml: 'xml', svg: 'xml', css: 'css', sh: 'bash', bash: 'bash', zsh: 'bash', yml: 'yaml', yaml: 'yaml', sql: 'sql',
};
function syntaxOf(it: Item): string {
  if (it.syntax) return it.syntax;
  const ext = /\.([^./]+)$/.exec(it.name)?.[1].toLowerCase();
  if (ext && EXT_SYNTAX[ext]) return EXT_SYNTAX[ext];
  const shebang = /^#!.*\b(python|bash|sh|zsh|node)\b/.exec(it.text?.slice(0, 120) ?? '')?.[1];
  if (shebang) return shebang === 'python' ? 'python' : shebang === 'node' ? 'javascript' : 'bash';
  return lang(it) === 'json' ? 'json' : 'plaintext';
}

const mimeOf = (it: Item) => ({ json: 'application/json', js: 'text/javascript', text: 'text/plain;charset=utf-8', binary: 'application/octet-stream' })[lang(it)];
const blobOf = (it: Item): Blob => (it.blob && !it.edited ? it.blob : new Blob([it.text ?? ''], { type: mimeOf(it) }));
/** Name without extension, a trailing ".min" and a " (2)"-style copy suffix. */
const stem = (name: string) => name.replace(/( \(\d+\))?(\.min)?\.[^./]+$/i, '') || name;

function hexDump(b: Uint8Array): string {
  const rows: string[] = [];
  for (let o = 0; o < b.length; o += 16) {
    const row = [...b.subarray(o, o + 16)];
    const hex = row.map((x) => x.toString(16).padStart(2, '0')).join(' ').padEnd(47);
    const ascii = row.map((x) => (x >= 32 && x < 127 ? String.fromCharCode(x) : '.')).join('');
    rows.push(`${o.toString(16).padStart(8, '0')}  ${hex}  ${ascii}`);
  }
  return rows.join('\n');
}

/** Character offset of a 1-based line and column. */
function offsetOf(text: string, line: number, col: number): number {
  let i = 0;
  for (let l = 1; l < line; l++) {
    const n = text.indexOf('\n', i);
    if (n < 0) break;
    i = n + 1;
  }
  return Math.min(text.length, i + Math.max(0, col - 1));
}

/** 1-based line and column of a character offset. */
function lineColAt(text: string, pos: number): [number, number] {
  let line = 1;
  let start = 0;
  for (let i = text.indexOf('\n'); i !== -1 && i < pos; i = text.indexOf('\n', i + 1)) {
    line++;
    start = i + 1;
  }
  return [line, pos - start + 1];
}

function checkJson(text: string): NonNullable<Item['json']> {
  const err = jsonError(text);
  if (!err) return { ok: true };
  const at = jsonErrorAt(text);
  if (at < 0) return { ok: false, message: err };
  const [line, col] = lineColAt(text, at);
  return { ok: false, line, col, message: /line \d+/i.test(err) ? err : `${err} (line ${line}, column ${col})` };
}

export function initFilesApp(): void {
  const root = document.querySelector<HTMLElement>('[data-fx]')!;
  const $ = <T extends Element = HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  const $$ = <T extends Element = HTMLElement>(sel: string) => root.querySelectorAll<T>(sel);
  const input = $<HTMLInputElement>('[data-input]');
  const ta = $<HTMLTextAreaElement>('[data-text]');
  const code = $('[data-code]');
  const gutter = $('[data-gutter]');
  const curline = $('[data-curline]');
  const hex = $('[data-hex]');
  const empty = $('[data-empty-state]');
  const filesEl = $<HTMLUListElement>('[data-files]');
  const tabsEl = $('[data-tabs]');
  const out = $<HTMLOListElement>('[data-out]');
  const outToggle = $<HTMLButtonElement>('[data-out-toggle]');
  const explorer = $('#fx-explorer');
  const explorerToggle = $<HTMLButtonElement>('[data-toggle-explorer]');
  const selectAll = $<HTMLInputElement>('[data-select-all]');
  const msg = $('[data-msg]');
  const progress = $<HTMLProgressElement>('[data-progress]');
  const trayEl = $('[data-tray]');
  const trayList = $<HTMLUListElement>('[data-tray-list]');
  const trayBusy = $('[data-tray-busy]');
  const dial = $('[data-dial]');
  const sbJson = $<HTMLButtonElement>('[data-sb-json]');
  const icons = $<HTMLTemplateElement>('[data-icons]');
  const icon = (name: string) => icons.content.querySelector(`[data-i="${name}"]`)!.firstElementChild!.cloneNode(true);
  const field = <T extends HTMLInputElement>(name: string) => root.querySelector<T>(`[name="${name}"]`)!;
  const checkedValue = (name: string) => root.querySelector<HTMLInputElement>(`[name="${name}"]:checked`)!.value;
  const narrow = matchMedia('(max-width: 760px)');
  const hlCode = $('[data-hl]');
  const mdEl = $('[data-md]');
  const editorEl = $('#fx-editor');
  const sbSyntax = $<HTMLSelectElement>('[data-sb-syntax]');
  const starter = $('[data-start-typing]');
  const outPanel = $('[data-out-panel]');

  let items: Item[] = [];
  let open: number[] = [];
  let active: number | undefined;
  const ticked = new Set<number>();
  let tray: number[] = []; // item ids collected in the archive tray
  let anchor: number | undefined;
  let roving: number | undefined;
  let nextId = 1;
  let untitled = 0;
  let shown: number | undefined; // item currently loaded in the textarea
  let dirty = false; // textarea differs from that item's text
  let lineCount = 1;
  let escaped = false;
  let busy: AbortController | null = null;
  let busyInTray = false;
  let tool: Tool = 'json';

  const byId = (id: number | undefined) => items.find((i) => i.id === id);
  const cur = () => byId(active);
  const curText = () => {
    const it = cur();
    return it?.text !== undefined ? it : undefined;
  };
  const sync = () => {
    const it = byId(shown);
    if (dirty && it?.text !== undefined) it.text = ta.value;
    dirty = false;
  };
  const uniqueName = (name: string) => {
    let n = name;
    for (let i = 2; items.some((it) => it.name === n); i++) n = name.replace(/(\.[^.]*)?$/, ` (${i})$1`);
    return n;
  };

  // ---- Messages: a short line in the tab row + the Output panel (shown only once something is logged) ----
  let sayTimer = 0;
  const say = (text: string, kind: Kind = 'info') => {
    msg.textContent = text;
    msg.dataset.kind = kind;
    clearTimeout(sayTimer);
    // Errors stay until the next message; they are also in the Output panel.
    if (text && kind !== 'error') sayTimer = window.setTimeout(() => (msg.textContent = ''), 6000);
  };
  const setOutOpen = (open: boolean) => {
    outToggle.ariaExpanded = String(open);
    out.hidden = !open;
    $('[data-resize-out]').hidden = !open;
  };
  const renderProblemCount = () => {
    const n = out.querySelectorAll('[data-kind="error"]').length;
    const badge = $('[data-problems]');
    badge.textContent = String(n);
    badge.hidden = n === 0;
    badge.ariaLabel = `${n} error${n === 1 ? '' : 's'}`;
  };
  function log(kind: Kind, text: string, at?: { id: number; line: number; col: number }) {
    say(text, kind);
    const li = el('li', {}, icon(kind === 'error' || kind === 'warn' ? 'warning' : kind === 'ok' ? 'check' : 'doc'), el('span', { className: 'fx-out-text', textContent: text }));
    li.dataset.kind = kind;
    if (at) {
      const jump = el('button', { type: 'button', className: 'fx-out-jump', textContent: `Ln ${at.line}, Col ${at.col}`, ariaLabel: `Go to line ${at.line}, column ${at.col}` });
      jump.onclick = () => (byId(at.id) ? jumpTo(at.id, at.line, at.col) : say('That document was removed.', 'error'));
      li.append(jump);
    }
    out.append(li);
    outPanel.hidden = false;
    while (out.children.length > 200) out.firstElementChild!.remove();
    if (kind === 'error' || kind === 'warn') setOutOpen(true);
    out.scrollTop = out.scrollHeight;
    renderProblemCount();
  }

  // ---- Editor ----
  const caretLineCol = () => lineColAt(ta.value, ta.selectionDirection === 'backward' ? ta.selectionStart : ta.selectionEnd);

  let paintQueued = false;
  function paint() {
    if (paintQueued) return;
    paintQueued = true;
    requestAnimationFrame(() => {
      paintQueued = false;
      if (code.hidden) return;
      const first = Math.floor(ta.scrollTop / LINE);
      const last = Math.min(lineCount, first + Math.ceil(ta.clientHeight / LINE) + 1);
      const nums: number[] = [];
      for (let n = first + 1; n <= last; n++) nums.push(n);
      gutter.textContent = nums.join('\n');
      gutter.style.transform = `translateY(${first * LINE - ta.scrollTop}px)`;
      const [line, col] = caretLineCol();
      curline.style.transform = `translateY(${(line - 1) * LINE - ta.scrollTop}px)`;
      const selLen = Math.abs(ta.selectionEnd - ta.selectionStart);
      $('[data-sb-pos]').textContent = `Ln ${line}, Col ${col}${selLen ? ` (${selLen} selected)` : ''}`;
    });
  }

  // Expensive per-document work (line count, byte size, JSON check) runs debounced after edits.
  let analyseTimer = 0;
  function analyse(delay = 0) {
    clearTimeout(analyseTimer);
    analyseTimer = window.setTimeout(() => {
      sync();
      const it = curText();
      if (it) {
        const t = it.text!;
        let n = 1;
        for (let i = t.indexOf('\n'); i !== -1; i = t.indexOf('\n', i + 1)) n++;
        lineCount = n;
        code.style.setProperty('--fx-gw', `${Math.max(3, String(n).length) + 1}ch`);
        if (it.edited) it.size = new Blob([t]).size;
        if (lang(it) === 'json' || tool === 'json') {
          if (it.size <= WARN_TEXT && t.trim()) it.json = checkJson(t);
          else if (it.edited) it.json = undefined;
        }
        filesEl.querySelector(`[data-id="${it.id}"] .fx-size`)!.textContent = formatBytes(it.size);
      }
      renderStatus();
      paint();
    }, delay);
  }

  function renderStatus() {
    const it = cur();
    const text = it?.text !== undefined;
    $('[data-sb-size]').textContent = it ? formatBytes(it.size) : '';
    // The language picker covers text documents; binary files just say so.
    $('[data-sb-lang]').textContent = it && !text ? 'Binary' : '';
    sbSyntax.hidden = !text;
    if (text) sbSyntax.value = syntaxOf(it);
    if (!text) $('[data-sb-pos]').textContent = '';
    const showJson = text && (lang(it) === 'json' || (tool === 'json' && syntaxOf(it) === 'plaintext')) && it.text!.trim() !== '';
    sbJson.hidden = !showJson;
    if (showJson) {
      const state = it.json ? (it.json.ok ? 'valid' : 'invalid') : 'unknown';
      sbJson.dataset.state = state;
      sbJson.replaceChildren(icon(state === 'invalid' ? 'warning' : 'check'), state === 'valid' ? 'Valid JSON' : state === 'invalid' ? 'Invalid JSON' : 'Check JSON');
      sbJson.title = it.json?.message ?? 'Validate JSON';
    }
  }

  // ---- Highlighting (overlay) and Markdown preview; both modules load on first need ----
  const HL_MAX = 300 * 1024;
  let hl: typeof Highlight | undefined;
  let md: typeof Markdown | undefined;
  let synTimer = 0;
  let mdTimer = 0;
  // Lazy on purpose: highlight.js only downloads when a highlighted language is first shown.
  const loadHl = () => import('./highlight').then((m) => (hl = m));

  function syncHl() {
    hlCode.style.transform = `translate(${-ta.scrollLeft}px, ${-ta.scrollTop}px)`;
  }

  /** Redraws the overlay; small documents synchronously, larger ones after a short pause in typing. */
  function refreshHl(now = false) {
    const it = curText();
    const syntax = it ? syntaxOf(it) : 'plaintext';
    const large = ta.value.length >= HL_MAX;
    const want = !!it && !code.hidden && syntax !== 'plaintext' && !large;
    $('[data-sb-hl]').textContent = it && syntax !== 'plaintext' && large ? 'Highlighting off (large file)' : '';
    if (want && !hl) void loadHl().then(() => refreshHl(true));
    const on = want && !!hl;
    code.toggleAttribute('data-hl-on', on);
    clearTimeout(synTimer);
    if (!on) return void (hlCode.textContent = '');
    // highlight() returns escaped HTML generated from the text, never raw user markup.
    const draw = () => {
      hlCode.innerHTML = hl!.highlight(ta.value, syntax) + '\n';
      syncHl();
    };
    if (now || ta.value.length < 20_000) return draw();
    hlCode.textContent = ta.value + '\n';
    syncHl();
    synTimer = window.setTimeout(draw, 90);
  }

  /** Markdown view controls and preview visibility for the active document. */
  function renderMdChrome() {
    const it = curText();
    const isMd = !!it && syntaxOf(it) === 'markdown';
    const view = isMd ? (it.mdView ?? 'edit') : 'edit';
    $('[data-md-modes]').hidden = !isMd;
    $('[data-md-html]').hidden = !isMd;
    field(`mdView"][value="${view}`).checked = true;
    if (view === 'edit') delete editorEl.dataset.mdView;
    else editorEl.dataset.mdView = view;
    if (it) code.hidden = view === 'preview';
    mdEl.hidden = view === 'edit';
    if (!mdEl.hidden) scheduleMd(true);
  }

  function scheduleMd(now = false) {
    if (mdEl.hidden) return;
    clearTimeout(mdTimer);
    mdTimer = window.setTimeout(
      async () => {
        // Lazy on purpose: micromark + GFM only download when a preview is first shown.
        md ??= await import('./markdown');
        const it = curText();
        if (!it || mdEl.hidden) return;
        sync();
        const top = mdEl.scrollTop;
        mdEl.replaceChildren(md.renderMarkdown(it.text!));
        mdEl.scrollTop = top;
      },
      now ? 0 : 150,
    );
  }

  sbSyntax.append(...Object.entries(SYNTAXES).map(([value, label]) => el('option', { value, textContent: label })));
  sbSyntax.addEventListener('change', () => {
    const it = curText();
    if (!it) return;
    it.syntax = sbSyntax.value;
    renderMdChrome();
    refreshHl(true);
    renderStatus();
  });
  $$<HTMLInputElement>('[name="mdView"]').forEach((r) =>
    r.addEventListener('change', () => {
      const it = curText();
      if (!it) return;
      it.mdView = r.value as Item['mdView'];
      renderMdChrome();
      refreshHl(true);
      paint();
    }),
  );
  $('[data-md-html]').addEventListener('click', async () => {
    const it = curText();
    if (!it) return;
    sync();
    md ??= await import('./markdown');
    const title = stem(it.name) || 'document';
    downloadBlob(new Blob([md.markdownDocument(title, md.renderMarkdown(it.text!))], { type: 'text/html' }), `${title}.html`);
    say(`Downloading ${title}.html.`);
  });

  // Empty state: the faded sample is one focusable text box. Clicking it, or Enter while it has focus, starts an
  // untitled document with the caret at the start; printable keys and paste go through the app-wide handlers below.
  starter.addEventListener('click', () => newDoc());
  starter.addEventListener('keydown', (e) => {
    // IME input: open the document and let the composition continue in the editor.
    if (e.isComposing || e.key === 'Process') return void newDoc();
    if (e.key !== 'Enter') return;
    e.preventDefault();
    newDoc('\n');
  });

  function saveView() {
    const it = cur();
    if (it?.text === undefined || code.hidden) return;
    sync();
    it.view = { start: ta.selectionStart, end: ta.selectionEnd, dir: ta.selectionDirection ?? 'none', top: ta.scrollTop, left: ta.scrollLeft };
  }

  let hexToken = 0;
  function showActive() {
    sync();
    const it = cur();
    const diffing = active === DIFF;
    empty.hidden = !!it || diffing;
    code.hidden = it?.text === undefined;
    hex.hidden = !it || it.text !== undefined;
    $('[data-diff]').hidden = !diffing;
    $('#fx-editor').setAttribute('aria-labelledby', active !== undefined ? `fx-tab-${active}` : '');
    if (it?.text !== undefined) {
      if (shown !== it.id) {
        shown = it.id;
        ta.value = it.text;
        const v = it.view;
        ta.setSelectionRange(v?.start ?? 0, v?.end ?? 0, v?.dir);
        ta.scrollTop = v?.top ?? 0;
        ta.scrollLeft = v?.left ?? 0;
      }
    } else {
      shown = undefined;
      ta.value = '';
      if (it) {
        const token = ++hexToken;
        const blob = blobOf(it);
        const info = $('[data-info]');
        const rows: [string, string][] = [['Name', it.name], ['Size', `${formatBytes(it.size)} (${it.size.toLocaleString()} bytes)`], ['Type', TYPE_LABEL[it.sniffed]]];
        if (it.note) rows.push(['Note', it.note]);
        if (ARCHIVES.includes(it.sniffed)) rows.push(['Tip', 'Add it to the Archive tray to extract it.']);
        rows.push(['Preview', blob.size > 4096 ? 'First 4 KB, hexadecimal' : 'Hexadecimal']);
        info.replaceChildren(...rows.flatMap(([k, v]) => [el('dt', { textContent: k }), el('dd', { textContent: v })]));
        $('[data-hexdump]').textContent = '';
        void blob
          .slice(0, 4096)
          .arrayBuffer()
          .then((buf) => {
            if (token === hexToken) $('[data-hexdump]').textContent = hexDump(new Uint8Array(buf));
          });
      }
    }
    renderMdChrome();
    refreshHl(true);
    renderTabs();
    renderExplorer();
    renderTools();
    analyse();
  }

  /** `stay` keeps the narrow-screen Explorer drawer open (actions started from it). */
  function openItem(id: number, focus = false, stay = false) {
    if (active !== id) saveView();
    if (!open.includes(id)) open.push(id);
    active = id;
    showActive();
    const row = filesEl.querySelector<HTMLElement>(`[data-id="${id}"]`);
    if (row && (row.offsetTop < filesEl.scrollTop || row.offsetTop + row.offsetHeight > filesEl.scrollTop + filesEl.clientHeight)) {
      filesEl.scrollTop = row.offsetTop - filesEl.clientHeight / 2;
    }
    if (narrow.matches && !stay) setExplorer(false);
    if (focus) (cur()?.text !== undefined ? ta : hex).focus();
  }

  function closeTab(id: number) {
    const i = open.indexOf(id);
    if (i < 0) return;
    if (id === active) {
      saveView();
      open.splice(i, 1);
      active = open[Math.min(i, open.length - 1)];
    } else open.splice(i, 1);
    showActive();
  }

  function removeItem(id: number) {
    closeTab(id);
    items = items.filter((it) => it.id !== id);
    ticked.delete(id);
    tray = tray.filter((t) => t !== id);
    if (roving === id) roving = undefined;
    renderExplorer();
    renderTools();
  }

  function addItem(props: Omit<Item, 'id' | 'edited' | 'mtime'> & { mtime?: number }): Item {
    const it: Item = { mtime: Date.now(), ...props, id: nextId++, edited: false };
    items.push(it);
    return it;
  }

  function newDoc(text = '') {
    const it = addItem({ name: uniqueName(`Untitled-${++untitled}`), text, size: new Blob([text]).size, sniffed: 'unknown', generated: true });
    openItem(it.id);
    ta.setSelectionRange(text.length, text.length);
    ta.focus();
    return it;
  }

  /** Place text in the empty active document, or in a new one. */
  function putText(text: string) {
    const it = curText();
    if (it && !(dirty ? ta.value : it.text)) {
      ta.value = text;
      dirty = true;
      it.edited = true;
      ta.focus();
      analyse();
    } else newDoc(text);
    if (new Blob([text]).size > WARN_TEXT) log('warn', 'Large document: the editor may be slow.');
  }

  function jumpTo(id: number, line: number, col: number) {
    openItem(id);
    const off = offsetOf(ta.value, line, col);
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(off, off);
    ta.scrollTop = Math.max(0, (line - 1) * LINE - ta.clientHeight / 2);
    const charW = parseFloat(getComputedStyle(ta).fontSize) * 0.6;
    ta.scrollLeft = Math.max(0, col * charW - ta.clientWidth / 2);
    paint();
  }

  /** Insert at the caret, keeping the browser's undo history. */
  function insert(text: string) {
    if (!document.execCommand('insertText', false, text)) {
      ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end');
      ta.dispatchEvent(new Event('input'));
    }
  }

  // ---- Explorer ----
  const kindIcon = (it: Item) => {
    const l = lang(it);
    if (l === 'json') return 'braces';
    if (l === 'js') return 'code';
    if (l === 'text') return 'doc';
    return ({ jpeg: 'images', png: 'images', webp: 'images', pdf: 'pdf', unknown: 'doc' } as Record<string, string>)[it.sniffed] ?? 'files';
  };
  // Folder prefixes (from extracted archives) are shown muted before the file name.
  const nameEl = (name: string) => {
    const i = name.lastIndexOf('/');
    return el('span', { className: 'fx-name' }, ...(i < 0 ? [name] : [el('span', { className: 'fx-dir', textContent: name.slice(0, i + 1) }), name.slice(i + 1)]));
  };

  function rove(id: number | undefined) {
    roving = id;
    for (const row of filesEl.children as HTMLCollectionOf<HTMLElement>) {
      const on = Number(row.dataset.id) === id;
      row.querySelectorAll<HTMLElement>('button, input').forEach((c) => (c.tabIndex = on ? 0 : -1));
    }
  }

  function renderExplorer() {
    // Rows are rebuilt; keep keyboard focus on the same control.
    const f = document.activeElement as HTMLElement | null;
    const fRow = f && filesEl.contains(f) ? f.closest<HTMLElement>('.fx-row') : null;
    const fIndex = fRow ? [...fRow.querySelectorAll('button, input')].indexOf(f!) : -1;
    filesEl.replaceChildren(
      ...items.map((it) => {
        const row = el('li', { className: 'fx-row', draggable: true });
        row.dataset.id = String(it.id);
        row.dataset.kind = lang(it);
        if (it.id === active) row.dataset.active = '';
        const cb = el('input', { type: 'checkbox', checked: ticked.has(it.id), ariaLabel: `Select ${it.name}` });
        cb.onchange = () => tick(it.id, cb.checked);
        const openBtn = el('button', { type: 'button', className: 'fx-open', title: it.name }, icon(kindIcon(it)), nameEl(it.name), el('span', { className: 'fx-size', textContent: formatBytes(it.size) }));
        openBtn.dataset.open = '';
        if (it.id === active) openBtn.ariaCurrent = 'true';
        openBtn.onclick = (e) => {
          if (e.ctrlKey || e.metaKey) return tick(it.id, !ticked.has(it.id));
          if (e.shiftKey && anchor !== undefined && byId(anchor)) {
            const [a, b] = [items.findIndex((x) => x.id === anchor), items.indexOf(it)].sort((x, y) => x - y);
            items.slice(a, b + 1).forEach((x) => ticked.add(x.id));
            renderExplorer();
            return renderTools();
          }
          anchor = it.id;
          openItem(it.id);
        };
        const btn = (name: string, label: string, fn: () => void) => {
          const b = el('button', { type: 'button', className: 'fx-ib', ariaLabel: `${label} ${it.name}`, title: label }, icon(name));
          b.onclick = fn;
          return b;
        };
        const acts = el('span', { className: 'fx-acts' });
        if (it.generated) acts.append(btn('edit', 'Rename', () => rename(it.id)));
        acts.append(btn('download', 'Download', () => downloadBlob(blobOf(it), it.name)), btn('trash', 'Remove', () => removeItem(it.id)));
        row.append(cb, openBtn, acts);
        return row;
      }),
    );
    rove(byId(roving) ? roving : (active ?? items[0]?.id));
    if (fRow) (filesEl.querySelector(`[data-id="${fRow.dataset.id}"]`)?.querySelectorAll<HTMLElement>('button, input')[fIndex] ?? filesEl.querySelector<HTMLElement>('.fx-open[tabindex="0"]'))?.focus();
    $('[data-files-empty]').hidden = items.length > 0;
    $('[data-count]').textContent = items.length ? `${items.length} file${items.length === 1 ? '' : 's'}` : '';
    $('[data-selbar]').hidden = ticked.size === 0;
    $('[data-sel-count]').textContent = `${ticked.size} selected`;
    const sel = items.filter((it) => ticked.has(it.id));
    $('[data-sel-compare]').hidden = !(sel.length === 2 && sel.every((it) => it.text !== undefined));
    selectAll.disabled = !items.length;
    selectAll.checked = items.length > 0 && ticked.size === items.length;
    selectAll.indeterminate = ticked.size > 0 && ticked.size < items.length;
  }

  function tick(id: number, on: boolean) {
    if (on) ticked.add(id);
    else ticked.delete(id);
    anchor = id;
    renderExplorer();
    renderTools();
  }

  function rename(id: number) {
    const it = byId(id);
    const row = filesEl.querySelector<HTMLElement>(`[data-id="${id}"]`);
    if (!it || !row) return;
    const openBtn = row.querySelector<HTMLElement>('.fx-open')!;
    const field = el('input', { type: 'text', className: 'fx-rename', value: it.name, ariaLabel: `New name for ${it.name}`, spellcheck: false });
    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      // Path separators would create folders inside ZIP archives.
      const name = field.value.trim().replace(/[\\/]+/g, '-');
      if (save && name && name !== it.name) it.name = uniqueName(name);
      renderExplorer();
      renderTabs();
      renderStatus();
      filesEl.querySelector<HTMLElement>(`[data-id="${id}"] .fx-open`)?.focus();
    };
    field.onkeydown = (e) => {
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') {
        e.stopPropagation();
        finish(false);
      }
    };
    field.onblur = () => finish(true);
    openBtn.replaceWith(field);
    field.focus();
    field.setSelectionRange(0, stem(it.name).length);
  }

  filesEl.addEventListener('focusin', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('.fx-row');
    if (row && Number(row.dataset.id) !== roving) rove(Number(row.dataset.id));
  });
  filesEl.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if (t.classList.contains('fx-rename')) return;
    const rows = [...filesEl.children] as HTMLElement[];
    const i = rows.findIndex((r) => r.contains(t));
    const id = Number(rows[i]?.dataset.id);
    let next = -1;
    if (e.key === 'ArrowDown') next = Math.min(rows.length - 1, i + 1);
    else if (e.key === 'ArrowUp') next = Math.max(0, i - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = rows.length - 1;
    else if (e.key === 'F2' && byId(id)?.generated) rename(id);
    else if (e.key === 'Delete' && t.classList.contains('fx-open')) {
      removeItem(id);
      filesEl.querySelector<HTMLElement>('.fx-open[tabindex="0"]')?.focus();
    } else return;
    e.preventDefault();
    if (next >= 0) {
      rove(Number(rows[next].dataset.id));
      rows[next].querySelector<HTMLElement>('.fx-open')!.focus();
    }
  });
  selectAll.onchange = () => {
    items.forEach((it) => (selectAll.checked ? ticked.add(it.id) : ticked.delete(it.id)));
    renderExplorer();
    renderTools();
  };

  // ---- Tabs ----
  function renderTabs() {
    const hadFocus = tabsEl.contains(document.activeElement);
    tabsEl.replaceChildren(
      ...open.map((id) => {
        const it = byId(id);
        const x = el('span', { className: 'fx-tab-x', title: 'Close' }, icon('xmark'));
        x.dataset.x = '';
        x.ariaHidden = 'true';
        const tab = el('button', { type: 'button', className: 'fx-tab', id: `fx-tab-${id}`, tabIndex: id === active ? 0 : -1 }, icon(it ? kindIcon(it) : 'compare'), el('span', { className: 'fx-tab-name', textContent: it?.name ?? diffTitle() }), x);
        tab.role = 'tab';
        tab.ariaSelected = String(id === active);
        tab.setAttribute('aria-controls', 'fx-editor');
        tab.dataset.id = String(id);
        return tab;
      }),
    );
    const sel = tabsEl.querySelector<HTMLElement>('[aria-selected="true"]');
    if (sel) {
      tabsEl.scrollLeft = Math.min(Math.max(tabsEl.scrollLeft, sel.offsetLeft + sel.offsetWidth - tabsEl.clientWidth), sel.offsetLeft);
      if (hadFocus) sel.focus();
    }
    const it = cur();
    $<HTMLButtonElement>('[data-copy]').disabled = it?.text === undefined;
    $<HTMLButtonElement>('[data-download]').disabled = !it;
    $<HTMLButtonElement>('[data-close]').disabled = !it;
  }
  tabsEl.addEventListener('click', (e) => {
    const tab = (e.target as HTMLElement).closest<HTMLElement>('.fx-tab');
    if (!tab) return;
    const id = Number(tab.dataset.id);
    if ((e.target as HTMLElement).closest('[data-x]')) closeTab(id);
    else openItem(id);
  });
  tabsEl.addEventListener('auxclick', (e) => {
    const tab = (e.target as HTMLElement).closest<HTMLElement>('.fx-tab');
    if (tab && e.button === 1) closeTab(Number(tab.dataset.id));
  });
  tabsEl.addEventListener('keydown', (e) => {
    const i = open.indexOf(Number((e.target as HTMLElement).dataset.id));
    if (i < 0) return;
    let next = -1;
    if (e.key === 'ArrowRight') next = (i + 1) % open.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + open.length) % open.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = open.length - 1;
    else if (e.key === 'Delete') {
      closeTab(open[i]);
      focusAfterClose();
    } else return;
    e.preventDefault();
    if (next >= 0) {
      openItem(open[next]);
      tabsEl.querySelector<HTMLElement>(`#fx-tab-${open[next]}`)?.focus();
    }
  });
  const focusAfterClose = () => (tabsEl.querySelector<HTMLElement>('[aria-selected="true"]') ?? $('[data-empty-state] [data-open]')).focus();

  // ---- Tools ----
  function setTool(t: Tool, focusTray = false) {
    tool = t;
    field(`tool"][value="${t}`).checked = true;
    const archive = t === 'zip' || t === 'gzip';
    $$('[data-panel]').forEach((p) => (p.hidden = p.dataset.panel !== (archive ? 'archive' : t)));
    if (archive) showTray(focusTray);
    renderTools();
    analyse();
  }

  let hlTimer = 0;
  /** Open the Explorer and draw attention to the archive tray. */
  function showTray(focus: boolean) {
    setExplorer(true);
    trayEl.dataset.hl = '';
    clearTimeout(hlTimer);
    hlTimer = window.setTimeout(() => delete trayEl.dataset.hl, 1600);
    if (focus) trayEl.focus({ preventScroll: true });
  }

  function renderTools() {
    const it = cur();
    const isText = it?.text !== undefined;
    const set = (act: string, enabled: boolean) => ($<HTMLButtonElement>(`[data-act="${act}"]`).disabled = !!busy || !enabled);
    ['validate', 'minify-json', 'format', 'minify-js'].forEach((a) => set(a, isText));
    $$<HTMLButtonElement>('[data-tray-add]').forEach((b) => (b.disabled = !!busy || (!ticked.size && !it)));
    renderTray();
    renderCompareChoices();
  }

  const plural = (n: number, word = 'file') => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
  const trayItems = () => tray.map((id) => byId(id)!);

  function renderTray() {
    const list = trayItems();
    const hadFocus = trayList.contains(document.activeElement);
    trayList.replaceChildren(
      ...list.map((it, i) => {
        const remove = el('button', { type: 'button', className: 'fx-ib', ariaLabel: `Remove ${it.name} from the archive tray`, title: 'Remove from the tray' }, icon('xmark'));
        remove.onclick = () => {
          tray.splice(i, 1);
          renderTools();
          (trayList.querySelectorAll('button')[Math.min(i, tray.length - 1)] ?? trayEl).focus();
        };
        return el('li', { className: 'fx-tray-row', title: it.name }, icon(kindIcon(it)), nameEl(it.name), el('span', { className: 'fx-size', textContent: formatBytes(it.size) }), remove);
      }),
    );
    if (hadFocus && !trayList.contains(document.activeElement)) trayEl.focus();
    const total = list.reduce((s, it) => s + it.size, 0);
    $('[data-tray-count]').textContent = list.length ? `${plural(list.length)} · ${formatBytes(total)}` : '';
    const archives = list.filter((it) => ARCHIVES.includes(it.sniffed)).length;
    // A tray holding only archives is most likely there to be extracted.
    const extract = list.length > 0 && archives === list.length;
    const gzRadio = field('fmt"][value="gz');
    gzRadio.disabled = list.length !== 1 && !gzRadio.checked;
    const fmt = checkedValue('fmt');
    $('[data-levels="zip"]').hidden = fmt !== 'zip';
    $('[data-levels="7z"]').hidden = fmt !== '7z';
    $$('[data-fmt-pass]').forEach((n) => (n.hidden = fmt !== '7z'));
    $('[data-fmt-name]').hidden = fmt === 'gz';
    $('[data-ext]').textContent = fmt === '7z' ? '.7z' : '.zip';
    const set = (act: string, enabled: boolean, primary: boolean, show = true) => {
      const b = $<HTMLButtonElement>(`[data-act="${act}"]`);
      b.hidden = !show;
      b.disabled = !!busy || !enabled;
      b.classList.toggle('fx-primary', primary && enabled);
    };
    const create = $('[data-act="create"]');
    create.textContent = fmt === '7z' ? 'Create 7z' : fmt === 'gz' ? 'Gzip' : 'Create ZIP';
    create.title = fmt === 'gz' && list.length !== 1 ? 'Gzip compresses a single file: keep exactly one file in the tray.' : '';
    set('create', list.length > 0 && (fmt !== 'gz' || list.length === 1), !extract);
    set('extract', archives > 0, extract, archives > 0);
    $<HTMLButtonElement>('[data-tray-clear]').disabled = !!busy || !list.length;
    const it = cur();
    const hexBtn = $<HTMLButtonElement>('[data-hex-tray]');
    hexBtn.hidden = !it || it.text !== undefined || !ARCHIVES.includes(it.sniffed);
    hexBtn.disabled = !!it && tray.includes(it.id);
    hexBtn.querySelector('span:not(.icon)')!.textContent = hexBtn.disabled ? 'In the Archive tray' : 'Add to Archive tray';
  }

  function addToTray(ids: number[]) {
    const fresh = ids.filter((id) => byId(id) && !tray.includes(id));
    tray.push(...fresh);
    renderTools();
    say(fresh.length ? `Added ${plural(fresh.length)} to the archive tray.` : 'Already in the archive tray.');
  }

  function addSelectedToTray() {
    const ids = ticked.size ? items.filter((it) => ticked.has(it.id)).map((it) => it.id) : cur() ? [active!] : [];
    if (!ids.length) return say('Select files in the Explorer first.', 'error');
    ticked.clear();
    renderExplorer();
    addToTray(ids);
    showTray(true);
  }

  /** Archive work shows its progress over the tray; text tools use the status bar. */
  function startBusy(text: string, inTray = false) {
    busy = new AbortController();
    busyInTray = inTray;
    setBusyText(text);
    if (inTray) {
      trayBusy.hidden = false;
      dial.hidden = false;
      setDial(dial);
    } else {
      progress.hidden = false;
      progress.removeAttribute('value');
    }
    renderTools();
    return busy.signal;
  }
  function setBusyText(text: string) {
    say(text);
    $('[data-busy-text]').textContent = text;
  }
  function setFraction(f?: number) {
    if (busyInTray) setDial(dial, f);
    else if (f === undefined) progress.removeAttribute('value');
    else progress.value = f;
  }
  function endBusy() {
    busy = null;
    progress.hidden = true;
    trayBusy.hidden = true;
    renderTools();
  }
  $('[data-cancel]').addEventListener('click', () => busy?.abort());

  function fail(err: unknown) {
    if (err instanceof DOMException && err.name === 'AbortError') return say('Cancelled.');
    if (!(err instanceof UserError)) console.error(err);
    log('error', err instanceof UserError ? err.message : `Something went wrong: ${(err as Error).message ?? err}`);
  }

  function addOutput(name: string, data: { text?: string; blob?: Blob }, sniffed: Item['sniffed'] = 'unknown', note?: string) {
    const size = data.blob?.size ?? new Blob([data.text ?? '']).size;
    const it = addItem({ name: uniqueName(name), ...data, size, sniffed, generated: true, note });
    openItem(it.id, false, true);
    return it;
  }

  function needText(): Item {
    const it = curText();
    if (!it) throw new UserError('Open or paste a text document first.');
    sync();
    if (!it.text!.trim()) throw new UserError(`${it.name} is empty.`);
    return it;
  }

  async function runJson(action: 'format' | 'minify' | 'validate') {
    if (busy) return;
    try {
      const it = needText();
      const text = it.text!;
      startBusy('Checking JSON…');
      // Let the status paint before a potentially long synchronous parse.
      const painted = Promise.withResolvers<void>();
      requestAnimationFrame(() => setTimeout(painted.resolve));
      await painted.promise;
      it.json = checkJson(text);
      renderStatus();
      if (!it.json.ok) {
        const { line, col, message } = it.json;
        log('error', `${it.name}: invalid JSON. ${message}`, line ? { id: it.id, line, col: col! } : undefined);
        if (line) jumpTo(it.id, line, col!);
        return;
      }
      if (action === 'validate') return log('ok', `${it.name} is valid JSON.`);
      const minify = action === 'minify';
      const result = formatJson(text, minify ? '' : INDENTS[checkedValue('indent')]);
      const o = addOutput(`${stem(it.name)}${minify ? '.min' : ''}.json`, { text: result });
      o.json = { ok: true };
      log('ok', `${minify ? 'Minified' : 'Formatted'} ${it.name} → ${o.name}: ${formatBytes(it.size)} → ${formatBytes(o.size)}.`);
    } catch (err) {
      fail(err);
    } finally {
      if (busy) endBusy();
      renderStatus();
    }
  }

  async function runJs() {
    if (busy) return;
    try {
      const it = needText();
      if (it.size > MAX_JS) throw new UserError(`${it.name} is larger than ${formatBytes(MAX_JS)}, the limit for JavaScript.`);
      startBusy('Minifying…');
      // Code-split: Terser is large and only needed when minifying.
      const { minify } = await import('terser');
      let result: string;
      try {
        result =
          (
            await minify(it.text!, {
              module: field('module').checked,
              mangle: field('mangle').checked,
              compress: { drop_console: !field('keepConsole').checked },
            })
          ).code ?? '';
      } catch (err) {
        // Terser parse errors carry a 1-based line and 0-based col.
        const { message, line, col } = err as { message: string; line?: number; col?: number };
        if (!line) throw new UserError(`Could not minify ${it.name}: ${message}`);
        const at = { id: it.id, line, col: (col ?? 0) + 1 };
        log('error', `${it.name}: syntax error. ${message}`, at);
        jumpTo(at.id, at.line, at.col);
        return;
      }
      const o = addOutput(it.name.replace(/(\.[cm]?js)?$/i, (ext) => `.min${ext || '.js'}`), { text: result });
      const pct = it.size ? Math.round((1 - o.size / it.size) * 100) : 0;
      const gz = gzipSync(new TextEncoder().encode(result)).length;
      log('ok', `Minified ${it.name} → ${o.name}: ${formatBytes(it.size)} → ${formatBytes(o.size)} (${pct >= 0 ? `${pct}% smaller` : `${-pct}% larger`}) · gzip ≈ ${formatBytes(gz)}.`);
    } catch (err) {
      fail(err);
    } finally {
      if (busy) endBusy();
    }
  }

  /** Runs one archive-tray action under the tray's progress overlay; Cancel aborts `signal`. */
  async function trayRun(label: string, fn: (signal: AbortSignal) => Promise<void>) {
    if (busy) return;
    sync();
    const signal = startBusy(label, true);
    if (trayEl.contains(document.activeElement)) $('[data-cancel]').focus();
    try {
      await fn(signal);
    } catch (err) {
      fail(err);
    } finally {
      const refocus = trayBusy.contains(document.activeElement);
      endBusy();
      if (refocus) trayEl.focus();
    }
  }

  async function createZip(signal: AbortSignal) {
    const list = trayItems();
    if (!list.length) throw new UserError('Add files to the archive tray first.');
    const blobs = list.map(blobOf);
    const total = blobs.reduce((s, b) => s + b.size, 0);
    if (total > MAX_ZIP) throw new UserError(`The files in the tray add up to ${formatBytes(total)}; the ZIP limit is ${formatBytes(MAX_ZIP)}.`);
    const level = Number(checkedValue('level')) as 0 | 6 | 9;
    const name = (field('zipName').value.trim().replace(/[\\/]+/g, '-') || 'archive').replace(/\.zip$/i, '') + '.zip';
    // Deduplicate names so files with the same name don't overwrite each other.
    const entries: Zippable = {};
    for (const [i, it] of list.entries()) {
      throwIfAborted(signal);
      setFraction(i / list.length);
      let entry = it.name;
      for (let n = 2; entry in entries; n++) entry = it.name.replace(/(\.[^./]*)?$/, ` (${n})$1`);
      entries[entry] = [new Uint8Array(await blobs[i].arrayBuffer()), { level, mtime: it.mtime }];
    }
    setBusyText('Compressing…');
    setFraction();
    const { promise, resolve, reject } = Promise.withResolvers<Uint8Array>();
    // Async fflate runs in workers and keeps the page responsive.
    const terminate = zip(entries, (err, data) => (err ? reject(err) : resolve(data)));
    signal.addEventListener('abort', () => {
      terminate();
      reject(new DOMException('Cancelled', 'AbortError'));
    });
    const data = await promise;
    const o = addOutput(name, { blob: new Blob([data as BlobPart], { type: 'application/zip' }) }, 'zip');
    log('ok', `Created ${o.name} from ${plural(list.length)}: ${formatBytes(total)} → ${formatBytes(o.size)}.`);
  }

  /** Streams `it` through gzip or gunzip and adds the result to the Explorer. */
  async function gzipItem(it: Item, compress: boolean, signal: AbortSignal) {
    const src = blobOf(it);
    if (src.size > MAX_GZ_IN) throw new UserError(`${it.name} is larger than ${formatBytes(MAX_GZ_IN)}, the gzip limit.`);
    if (!compress && (await sniff(src)) !== 'gzip') throw new UserError(`${it.name} is not gzip-compressed.`);
    const chunks: Uint8Array[] = [];
    let outSize = 0;
    const ondata = (chunk: Uint8Array) => {
      outSize += chunk.length;
      if (outSize > MAX_GZ_OUT) throw new UserError(`${it.name} decompresses to more than ${formatBytes(MAX_GZ_OUT)}; stopped to protect your device.`);
      chunks.push(chunk);
    };
    const stream = compress ? new Gzip({ mtime: it.mtime }, ondata) : new Gunzip(ondata);
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
      if (!compress) throw new UserError(`The gzip data in ${it.name} is damaged or incomplete.`);
      throw err;
    }
    const name = compress ? `${it.name}.gz` : it.name.replace(/\.tgz$/i, '.tar').replace(/\.gz$/i, '') || 'decompressed';
    const blob = new Blob(chunks as BlobPart[], { type: compress ? 'application/gzip' : 'application/octet-stream' });
    // Small UTF-8 results open as editable text; everything else is listed as a binary file.
    const o = await addBlob(uniqueName(name), blob, compress ? it.mtime : Date.now(), true, compress ? 0 : MAX_INLINE - 1);
    openItem(o.id, false, true);
    log('ok', `${compress ? 'Compressed' : 'Decompressed'} ${it.name} → ${o.name}: ${formatBytes(src.size)} → ${formatBytes(o.size)}.`);
  }

  /** Extracts every file entry of a ZIP into the Explorer, with entry-count and expanded-size guards. */
  async function unzipItem(it: Item, signal: AbortSignal) {
    const src = blobOf(it);
    if (src.size > MAX_ZIP) throw new UserError(`${it.name} is larger than ${formatBytes(MAX_ZIP)}, the ZIP limit.`);
    if ((await sniff(src)) !== 'zip') throw new UserError(`${it.name} is not a ZIP archive.`);
    if (await zipNeedsSevenZip(src)) return extract7z(it, signal);
    const entries: { name: string; chunks: Uint8Array[]; done: boolean; error?: string }[] = [];
    let total = 0;
    let renamed = 0;
    // fflate routes exceptions thrown in its callbacks back into ondata, so guards set `stop` and the push loop throws it.
    let stop: UserError | undefined;
    // Streaming: sizes are counted from the actual output, not trusted from the headers.
    const uz = new Unzip((file) => {
      // Folder entries (folders show up as name prefixes) and macOS resource-fork copies are skipped.
      if (stop || /[\\/]$/.test(file.name) || /^__MACOSX[\\/]/.test(file.name)) return;
      const name = safeEntryName(file.name);
      if (name !== file.name) renamed++;
      if (!name) return;
      if (entries.length >= MAX_ENTRIES) return void (stop = new UserError(`${it.name} holds more than ${plural(MAX_ENTRIES)}; stopped to protect your device.`));
      const entry: (typeof entries)[number] = { name, chunks: [], done: false };
      entries.push(entry);
      file.ondata = (err, chunk, final) => {
        if (stop) return;
        if (err) return void (entry.error = err.message);
        total += chunk.length;
        if (total > MAX_ZIP) return void (stop = new UserError(`${it.name} expands to more than ${formatBytes(MAX_ZIP)}; stopped to protect your device.`));
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
      return extract7z(it, signal);
    }
    const good = entries.filter((e) => e.done && !e.error);
    // Encrypted entries or methods fflate lacks (Deflate64, LZMA, AES…): hand the whole archive to 7-Zip.
    if (good.length < entries.length) return extract7z(it, signal);
    if (!good.length) throw new UserError(`${it.name} contains no files.`);
    setBusyText('Adding files…');
    const added: Item[] = [];
    for (const e of good) added.push(await addBlob(uniqueName(e.name), new Blob(e.chunks as BlobPart[]), Date.now(), true, MAX_INLINE - 1));
    openItem(added[0].id, false, true);
    log('ok', `Extracted ${plural(good.length)} from ${it.name}: ${formatBytes(src.size)} → ${formatBytes(total)}.`);
    if (renamed) log('warn', `${plural(renamed, 'entry name')} in ${it.name} pointed outside the archive or used unsafe characters; ${renamed === 1 ? 'it was' : 'they were'} cleaned up.`);
  }

  // ---- 7-Zip (worker + WASM, loaded on first use) ----
  async function create7z(signal: AbortSignal) {
    const list = trayItems();
    if (!list.length) throw new UserError('Add files to the archive tray first.');
    const blobs = list.map(blobOf);
    const total = blobs.reduce((s, b) => s + b.size, 0);
    if (total > MAX_ZIP) throw new UserError(`The files in the tray add up to ${formatBytes(total)}; the archive limit is ${formatBytes(MAX_ZIP)}.`);
    const name = (field('zipName').value.trim().replace(/[\\/]+/g, '-') || 'archive').replace(/\.(zip|7z)$/i, '') + '.7z';
    const password = field('zipPass').value;
    // Safe relative paths; duplicates get " (2)" like in ZIPs.
    const used = new Set<string>();
    const files = list.map((it, i) => {
      const base = safeEntryName(it.name) || `file-${i + 1}`;
      let n = base;
      for (let k = 2; used.has(n); k++) n = base.replace(/(\.[^./]*)?$/, ` (${k})$1`);
      used.add(n);
      return { name: n, blob: blobs[i] };
    });
    setBusyText('Compressing with 7-Zip…');
    const res = await runSevenZip({ op: 'create', files, level: Number(checkedValue('level7')) as 0 | 1 | 5 | 9, password: password || undefined }, { signal, onProgress: setFraction });
    if (res.type === 'error') throw new UserError(`Could not create ${name}: ${res.message}`);
    if (res.type !== 'created') throw new Error(`Unexpected 7-Zip reply: ${res.type}`);
    const o = addOutput(name, { blob: new Blob([res.data], { type: 'application/x-7z-compressed' }) }, '7z');
    log('ok', `Created ${o.name}${password ? ' (encrypted)' : ''} from ${plural(list.length)}: ${formatBytes(total)} → ${formatBytes(o.size)}.`);
  }

  async function extract7z(it: Item, signal: AbortSignal) {
    const src = blobOf(it);
    if (src.size > MAX_ZIP) throw new UserError(`${it.name} is larger than ${formatBytes(MAX_ZIP)}, the archive limit.`);
    let password: string | undefined;
    for (;;) {
      setBusyText(`Extracting ${it.name}…`);
      setFraction();
      const res = await runSevenZip({ op: 'extract', name: it.name, blob: src, password, maxBytes: MAX_ZIP, maxEntries: MAX_ENTRIES }, { signal, onProgress: setFraction });
      if (res.type === 'error') {
        if (res.code === 'password' || res.code === 'wrong-password') {
          password = await askPassword(it.name, res.code === 'wrong-password' && password !== undefined);
          if (password === undefined) throw new DOMException('Cancelled', 'AbortError');
          continue;
        }
        if (res.code === 'too-big') throw new UserError(`${it.name} expands to more than ${formatBytes(MAX_ZIP)}; stopped to protect your device.`);
        if (res.code === 'too-many') throw new UserError(`${it.name} holds more than ${plural(MAX_ENTRIES)}; stopped to protect your device.`);
        throw new UserError(`${it.name}: ${res.message}`);
      }
      if (res.type !== 'extracted') throw new Error(`Unexpected 7-Zip reply: ${res.type}`);
      setBusyText('Adding files…');
      const added: Item[] = [];
      let renamed = 0;
      let total = 0;
      for (const e of res.entries) {
        const name = safeEntryName(e.name);
        if (name !== e.name) renamed++;
        if (!name) continue;
        total += e.data.byteLength;
        added.push(await addBlob(uniqueName(name), new Blob([e.data]), Date.now(), true, MAX_INLINE - 1));
      }
      if (!added.length) throw new UserError(`${it.name} contains no files.`);
      openItem(added[0].id, false, true);
      log('ok', `Extracted ${plural(added.length)} from ${it.name}: ${formatBytes(src.size)} → ${formatBytes(total)}.`);
      if (res.skipped) log('warn', `${plural(res.skipped, 'link')} or special file${res.skipped === 1 ? '' : 's'} in ${it.name} ${res.skipped === 1 ? 'was' : 'were'} skipped.`);
      if (renamed) log('warn', `${plural(renamed, 'entry name')} in ${it.name} used unsafe characters and ${renamed === 1 ? 'was' : 'were'} cleaned up.`);
      if (res.warning) log('warn', `${it.name}: ${res.warning}`);
      return;
    }
  }

  /** Modal password prompt; resolves undefined on cancel. The password is only handed to the worker for this job. */
  function askPassword(name: string, wrong: boolean): Promise<string | undefined> {
    const dlg = $<HTMLDialogElement>('[data-pw-dialog]');
    const input = dlg.querySelector<HTMLInputElement>('input[name="pw"]')!;
    const err = $('[data-pw-error]');
    $('[data-pw-text]').textContent = `${name} is encrypted. Enter its password to extract it.`;
    err.textContent = wrong ? 'That password is wrong. Try again.' : '';
    err.hidden = !wrong;
    input.value = '';
    dlg.returnValue = '';
    const { promise, resolve } = Promise.withResolvers<string | undefined>();
    dlg.addEventListener(
      'close',
      () => {
        resolve(dlg.returnValue === 'ok' ? input.value : undefined);
        input.value = '';
      },
      { once: true },
    );
    dlg.showModal();
    return promise;
  }
  $('[data-pw-cancel]').addEventListener('click', () => $<HTMLDialogElement>('[data-pw-dialog]').close('cancel'));

  // ---- Files in: picker, hub hand-over, drop, paste ----
  /** Adds bytes to the Explorer: UTF-8 text up to `maxText` becomes an editable document, anything else a binary file. */
  async function addBlob(name: string, blob: Blob, mtime: number, generated: boolean, maxText = MAX_TEXT): Promise<Item> {
    const sniffed = await sniffAll(blob);
    const text = sniffed === 'unknown' ? await decodeText(blob, maxText) : null;
    let note: string | undefined;
    if (text === null && sniffed === 'unknown') note = blob.size > maxText ? `Larger than ${formatBytes(maxText)}, so it is not opened as text.` : 'Not UTF-8 text, so it is shown as binary.';
    if (text !== null && blob.size > WARN_TEXT) log('warn', `${name} is ${formatBytes(blob.size)}: the editor may be slow.`);
    return addItem({ name, text: text ?? undefined, blob, size: blob.size, sniffed, generated, mtime, note });
  }

  async function addFiles(files: File[], toTray = false) {
    const added: Item[] = [];
    for (const f of files) added.push(await addBlob(f.name, f, f.lastModified, false));
    if (!added.length) return;
    if (toTray) tray.push(...added.map((it) => it.id));
    // ?mode=markdown: the first Markdown file replaces the untouched placeholder and opens in Split view.
    const md = mdPlaceholder !== undefined ? added.find((it) => syntaxOf(it) === 'markdown') : undefined;
    if (md) {
      md.mdView = 'split';
      if (!byId(mdPlaceholder)?.edited) removeItem(mdPlaceholder!);
      mdPlaceholder = undefined;
    }
    openItem((md ?? added[0]).id, false, toTray);
    say(`Added ${plural(added.length)}${toTray ? ' to the archive tray' : ''}.`);
  }
  let mdPlaceholder: number | undefined;

  async function pasteFromClipboard() {
    let text: string;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      const it = curText() ?? newDoc();
      openItem(it.id, true);
      return log('warn', 'Clipboard access was blocked. Click in the editor and press Ctrl+V (⌘V on a Mac) instead.');
    }
    if (!text) return say('The clipboard has no text.', 'error');
    putText(text);
    say('Pasted from the clipboard.');
  }

  function download() {
    const it = cur();
    if (!it) return;
    sync();
    downloadBlob(blobOf(it), it.name);
    say(`Downloading ${it.name}.`);
  }

  function setExplorer(show: boolean) {
    explorer.hidden = !show;
    explorerToggle.ariaExpanded = String(show);
  }

  // ---- Wiring ----
  input.addEventListener('change', () => {
    const files = [...(input.files ?? [])];
    input.value = '';
    void addFiles(files, tool === 'zip' || tool === 'gzip');
  });
  $$('[data-open]').forEach((b) => b.addEventListener('click', () => input.click()));
  $$('[data-new]').forEach((b) => b.addEventListener('click', () => newDoc()));
  $$('[data-paste]').forEach((b) => b.addEventListener('click', () => void pasteFromClipboard()));
  explorerToggle.onclick = () => setExplorer(explorerToggle.ariaExpanded !== 'true');
  $('[data-copy]').addEventListener('click', async () => {
    const it = curText();
    if (!it) return;
    sync();
    try {
      await navigator.clipboard.writeText(it.text!);
      say(`Copied ${it.name}.`, 'ok');
    } catch {
      say('Copy failed. Select the text and copy it manually.', 'error');
    }
  });
  $('[data-download]').addEventListener('click', download);
  $('[data-close]').addEventListener('click', () => {
    if (active !== undefined) closeTab(active);
    focusAfterClose();
  });
  outToggle.onclick = () => setOutOpen(outToggle.ariaExpanded !== 'true');
  $('[data-out-clear]').addEventListener('click', () => {
    out.replaceChildren();
    say('');
    renderProblemCount();
    setOutOpen(false);
    outPanel.hidden = true;
  });
  sbJson.onclick = () => {
    const it = cur();
    if (it?.json?.line) jumpTo(it.id, it.json.line, it.json.col!);
    else void runJson('validate');
  };
  $$<HTMLInputElement>('[name="tool"]').forEach((r) => r.addEventListener('change', () => setTool(r.value as Tool)));
  const acts: Record<string, () => void> = {
    validate: () => runJson('validate'),
    'minify-json': () => runJson('minify'),
    format: () => runJson('format'),
    'minify-js': runJs,
    create: () => {
      const fmt = checkedValue('fmt');
      if (fmt === '7z') return trayRun('Starting 7-Zip…', create7z);
      if (fmt === 'zip') return trayRun('Reading files…', createZip);
      return trayRun('Compressing…', async (signal) => {
        const list = trayItems();
        if (list.length !== 1) throw new UserError('Gzip compresses a single file: keep exactly one file in the tray.');
        await gzipItem(list[0], true, signal);
      });
    },
    extract: () =>
      trayRun('Extracting…', async (signal) => {
        for (const it of trayItems().filter((x) => ARCHIVES.includes(x.sniffed))) {
          if (it.sniffed === 'zip') await unzipItem(it, signal);
          // Plain .gz stays with fflate; a gzipped tar is unpacked in one go by 7-Zip.
          else if (it.sniffed === 'gzip' && !/\.(tgz|tar\.gz)$/i.test(it.name)) await gzipItem(it, false, signal);
          else await extract7z(it, signal);
        }
      }),
    compare: () => void compareChosen(),
    'compare-clip': async () => {
      try {
        void compareChosen(await navigator.clipboard.readText());
      } catch {
        log('warn', 'Clipboard access was blocked. Paste the text into a new document (New, then Ctrl+V or ⌘V) and compare the two documents.');
      }
    },
  };

  // ---- Compare ----
  interface Source { name: string; id?: number; text?: string }
  let diffSrc: { a: Source; b: Source } | undefined;
  let diffBlocks: HTMLElement[][] = [];
  let diffCur = -1;
  const diffEl = $('[data-diff]');
  const diffBody = $('[data-diff-body]');
  const diffTitle = () => (diffSrc ? `${diffSrc.a.name} ↔ ${diffSrc.b.name}` : 'Compare');
  const textItems = () => items.filter((it) => it.text !== undefined);

  function renderCompareChoices() {
    const list = textItems();
    const [sa, sb] = ['cmpA', 'cmpB'].map((n) => root.querySelector<HTMLSelectElement>(`[name="${n}"]`)!);
    const keepA = Number(sa.value);
    const keepB = Number(sb.value);
    for (const s of [sa, sb]) s.replaceChildren(...list.map((it) => el('option', { value: String(it.id), textContent: it.name })));
    const a = list.find((it) => it.id === keepA) ?? curText() ?? list[0];
    const b = list.find((it) => it.id === keepB && it !== a) ?? list.find((it) => it !== a && open.includes(it.id)) ?? list.find((it) => it !== a);
    if (a) sa.value = String(a.id);
    if (b) sb.value = String(b.id);
    $<HTMLButtonElement>('[data-act="compare"]').disabled = list.length < 2;
    $<HTMLButtonElement>('[data-act="compare-clip"]').disabled = !list.length;
  }

  async function compare(a: Source, b: Source) {
    diffSrc = { a, b };
    saveView();
    if (!open.includes(DIFF)) open.push(DIFF);
    active = DIFF;
    say('Comparing…');
    const painted = Promise.withResolvers<void>();
    requestAnimationFrame(() => setTimeout(painted.resolve));
    await painted.promise;
    renderDiff();
    showActive();
    diffBody.focus({ preventScroll: true });
  }

  function compareChosen(clipboardText?: string) {
    const pick = (n: string) => byId(Number(root.querySelector<HTMLSelectElement>(`[name="${n}"]`)!.value));
    const a = pick('cmpA');
    if (!a) return say('Open or paste a text document first.', 'error');
    if (clipboardText !== undefined) return compare({ name: a.name, id: a.id }, { name: 'Clipboard', text: clipboardText });
    const b = pick('cmpB');
    if (!b || b === a) return say('Choose two different documents to compare.', 'error');
    return compare({ name: a.name, id: a.id }, { name: b.name, id: b.id });
  }

  const sourceText = (s: Source) => (s.id !== undefined ? (sync(), byId(s.id)?.text) : s.text);

  function renderDiff() {
    if (!diffSrc) return;
    let ta = sourceText(diffSrc.a);
    let tb = sourceText(diffSrc.b);
    const notices: string[] = [];
    $('[data-diff-names]').textContent = diffTitle();
    if (ta === undefined || tb === undefined) {
      ta ??= '';
      tb ??= '';
      notices.push('One of the documents was removed.');
    }
    if (field('normJson').checked) {
      if (jsonError(ta) || jsonError(tb)) notices.push('Normalize JSON needs valid JSON on both sides, so the plain text is compared.');
      else {
        try {
          const indent = INDENTS[checkedValue('indent')];
          [ta, tb] = [formatJson(sortJsonKeys(ta), indent), formatJson(sortJsonKeys(tb), indent)];
        } catch {
          notices.push('The JSON is nested too deeply to normalize, so the plain text is compared.');
        }
      }
    }
    const la = ta.split(/\r?\n/);
    const lb = tb.split(/\r?\n/);
    const { edits, exact } = diffLines(la, lb, field('ignoreWs').checked);
    if (!exact) notices.push('These texts are too different to compare precisely; the changed middle part is shown as one block.');
    const notice = $('[data-diff-notice]');
    notice.textContent = notices.join(' ');
    notice.hidden = !notices.length;

    // Rows: side by side pairs removed and added lines of each change block; unified (narrow) lists them one after another.
    const unified = narrow.matches;
    diffEl.toggleAttribute('data-unified', unified);
    type Row = { k: 'eq' | 'del' | 'add' | 'chg'; a?: number; b?: number; wa?: Array<[number, number]>; wb?: Array<[number, number]> };
    const rows: Row[] = [];
    const blocks: Array<[number, number]> = [];
    let adds = 0;
    let dels = 0;
    let runA: number[] = [];
    let runB: number[] = [];
    const flush = () => {
      if (!runA.length && !runB.length) return;
      const start = rows.length;
      const n = Math.max(runA.length, runB.length);
      const pairs: Row[] = [];
      for (let i = 0; i < n; i++) {
        const a = runA[i];
        const b = runB[i];
        const w = a !== undefined && b !== undefined ? diffWords(la[a], lb[b]) : null;
        pairs.push({ k: a === undefined ? 'add' : b === undefined ? 'del' : 'chg', a, b, wa: w?.[0], wb: w?.[1] });
      }
      if (unified) {
        for (const p of pairs) if (p.a !== undefined) rows.push({ k: 'del', a: p.a, wa: p.wa });
        for (const p of pairs) if (p.b !== undefined) rows.push({ k: 'add', b: p.b, wb: p.wb });
      } else rows.push(...pairs);
      blocks.push([start, rows.length]);
      adds += runB.length;
      dels += runA.length;
      runA = [];
      runB = [];
    };
    for (const [op, a, b] of edits) {
      if (op === 0) {
        flush();
        rows.push({ k: 'eq', a, b });
      } else if (op === 1) runA.push(a);
      else runB.push(b);
    }
    flush();

    const sum = $('[data-diff-sum]');
    sum.replaceChildren(
      el('span', { className: 'fx-sum-add', textContent: `+${adds.toLocaleString()}` }),
      ' ',
      el('span', { className: 'fx-sum-del', textContent: `−${dels.toLocaleString()}` }),
      ` · ${plural(blocks.length, 'change')}`,
    );
    sum.ariaLabel = `${plural(adds, 'addition')}, ${plural(dels, 'deletion')}, ${plural(blocks.length, 'change')}`;
    diffEl.style.setProperty('--fx-dn', `${String(Math.max(la.length, lb.length)).length + 1}ch`);

    const marked = (text: string, ranges?: Array<[number, number]>) => {
      if (!ranges?.length) return [text];
      const out: (string | HTMLElement)[] = [];
      let p = 0;
      for (const [s, e] of ranges) {
        out.push(text.slice(p, s), el('mark', { textContent: text.slice(s, e) }));
        p = e;
      }
      out.push(text.slice(p));
      return out;
    };
    const side = (kind: string, n: number | undefined, text: string | undefined, ranges?: Array<[number, number]>) => {
      const cells = [el('span', { className: 'fx-dn', textContent: n === undefined ? '' : String(n + 1) }), el('span', { className: 'fx-dm', textContent: kind === 'del' ? '−' : kind === 'add' ? '+' : '' }), el('span', { className: 'fx-dt' }, ...(text === undefined ? [] : marked(text, ranges)))];
      cells.forEach((c) => (c.dataset.s = kind));
      return cells;
    };
    const lineEl = (r: Row) => {
      const row = el('div', { className: 'fx-dl' });
      if (unified) {
        const kind = r.k === 'eq' ? 'eq' : r.k;
        const text = r.a !== undefined ? la[r.a] : lb[r.b!];
        const [, m, t] = side(kind, undefined, text, r.k === 'del' ? r.wa : r.wb);
        row.append(el('span', { className: 'fx-dn', textContent: r.a === undefined ? '' : String(r.a + 1) }), el('span', { className: 'fx-dn', textContent: r.b === undefined ? '' : String(r.b + 1) }), m, t);
        row.dataset.s = kind;
      } else {
        const ka = r.a === undefined ? 'none' : r.k === 'eq' ? 'eq' : 'del';
        const kb = r.b === undefined ? 'none' : r.k === 'eq' ? 'eq' : 'add';
        row.append(...side(ka, r.a, r.a === undefined ? undefined : la[r.a], r.wa), ...side(kb, r.b, r.b === undefined ? undefined : lb[r.b], r.wb));
      }
      return row;
    };

    // Unchanged stretches longer than 2×CONTEXT+2 lines fold into an expandable marker.
    const CONTEXT = 3;
    const near = new Uint8Array(rows.length);
    for (const [s, e] of blocks) near.fill(1, Math.max(0, s - CONTEXT), Math.min(rows.length, e + CONTEXT));
    const els: (HTMLElement | undefined)[] = new Array(rows.length);
    const frag: HTMLElement[] = [];
    for (let i = 0; i < rows.length; ) {
      if (near[i] || !blocks.length) {
        frag.push((els[i] = lineEl(rows[i])));
        i++;
        continue;
      }
      let j = i;
      while (j < rows.length && !near[j]) j++;
      const from = i;
      const fold = el('button', { type: 'button', className: 'fx-fold', textContent: `⋯ ${plural(j - from, 'unchanged line')}` });
      fold.onclick = () => {
        fold.replaceWith(...rows.slice(from, j).map(lineEl));
        diffBody.focus({ preventScroll: true });
      };
      frag.push(fold);
      i = j;
    }
    if (!blocks.length) frag.unshift(el('p', { className: 'fx-diff-same', textContent: field('ignoreWs').checked ? 'No differences apart from whitespace.' : 'The two texts are identical.' }));
    diffBody.replaceChildren(...frag);
    diffBlocks = blocks.map(([s, e]) => els.slice(s, e) as HTMLElement[]);
    diffCur = -1;
    $('[data-diff-pos]').textContent = '';
    $<HTMLButtonElement>('[data-diff-prev]').disabled = $<HTMLButtonElement>('[data-diff-next]').disabled = !blocks.length;
    say(blocks.length ? `${plural(blocks.length, 'change')}: ${plural(adds, 'line')} added, ${plural(dels, 'line')} removed.` : 'No differences.', 'ok');
    renderTabs();
  }

  function goChange(step: 1 | -1) {
    if (!diffBlocks.length) return;
    diffBlocks[diffCur]?.forEach((r) => r.removeAttribute('data-cur'));
    diffCur = diffCur < 0 ? (step > 0 ? 0 : diffBlocks.length - 1) : (diffCur + step + diffBlocks.length) % diffBlocks.length;
    const rows = diffBlocks[diffCur];
    rows.forEach((r) => r.setAttribute('data-cur', ''));
    diffBody.scrollTop = rows[0].offsetTop - diffBody.clientHeight / 3;
    const pos = `Change ${diffCur + 1} of ${diffBlocks.length}`;
    $('[data-diff-pos]').textContent = pos;
    say(pos);
  }

  $('[data-diff-next]').addEventListener('click', () => goChange(1));
  $('[data-diff-prev]').addEventListener('click', () => goChange(-1));
  $$('[name="ignoreWs"], [name="normJson"], [name="indent"]').forEach((c) => c.addEventListener('change', () => active === DIFF && renderDiff()));
  narrow.addEventListener('change', () => diffSrc && open.includes(DIFF) && renderDiff());
  $('[data-sel-compare]').addEventListener('click', () => {
    const [a, b] = items.filter((it) => ticked.has(it.id));
    ticked.clear();
    setTool('compare');
    void compare({ name: a.name, id: a.id }, { name: b.name, id: b.id });
  });

  // ---- Resizable Explorer and Output panel ----
  resizable($('[data-resize-side]'), {
    key: 'files.explorer',
    min: () => 180,
    max: () => Math.max(180, Math.round(root.clientWidth / 2)),
    initial: 280,
    apply: (v) => root.style.setProperty('--fx-sw', `${v}px`),
    // The handle sits on the Explorer's left edge and the Explorer ends at the app's right edge.
    fromPointer: (e) => root.getBoundingClientRect().right - e.clientX,
    growKey: 'ArrowLeft',
    shrinkKey: 'ArrowRight',
    container: root,
  });
  resizable($('[data-resize-out]'), {
    key: 'files.output',
    min: () => 60,
    max: () => Math.max(60, Math.round(root.clientHeight * 0.6)),
    initial: narrow.matches ? 96 : 132,
    apply: (v) => root.style.setProperty('--fx-out-h', `${v}px`),
    fromPointer: (e, s) => s.size + s.y - e.clientY,
    growKey: 'ArrowUp',
    shrinkKey: 'ArrowDown',
    container: root,
  });
  $$('[data-act]').forEach((b) => b.addEventListener('click', () => acts[b.dataset.act!]()));
  $$('[data-tray-add]').forEach((b) => b.addEventListener('click', addSelectedToTray));
  $$('[name="fmt"]').forEach((r) => r.addEventListener('change', renderTray));
  $('[data-tray-focus]').addEventListener('click', () => showTray(true));
  $('[data-hex-tray]').addEventListener('click', () => {
    if (active !== undefined) addToTray([active]);
    showTray(true);
  });
  $('[data-tray-clear]').addEventListener('click', () => {
    tray = [];
    renderTools();
    trayEl.focus();
  });
  $('[data-sel-clear]').addEventListener('click', () => {
    ticked.clear();
    renderExplorer();
    renderTools();
    filesEl.querySelector<HTMLElement>('.fx-open[tabindex="0"]')?.focus();
  });

  // Drag rows from the Explorer into the tray (all ticked rows when the dragged row is ticked).
  filesEl.addEventListener('dragstart', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('.fx-row');
    if (!row || !e.dataTransfer) return;
    const id = Number(row.dataset.id);
    const ids = ticked.has(id) ? items.filter((it) => ticked.has(it.id)).map((it) => it.id) : [id];
    e.dataTransfer.setData(DRAG_TYPE, ids.join(','));
    e.dataTransfer.effectAllowed = 'copy';
    row.classList.add('fx-dragging');
  });
  filesEl.addEventListener('dragend', (e) => (e.target as HTMLElement).closest('.fx-row')?.classList.remove('fx-dragging'));
  const trayAccepts = (e: DragEvent) => !!e.dataTransfer && (e.dataTransfer.types.includes(DRAG_TYPE) || e.dataTransfer.types.includes('Files'));
  trayEl.addEventListener('dragover', (e) => {
    if (!trayAccepts(e) || busy) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer!.dropEffect = 'copy';
    root.classList.remove('fx-over');
    trayEl.classList.add('over');
  });
  trayEl.addEventListener('dragleave', (e) => {
    if (!trayEl.contains(e.relatedTarget as Node | null)) trayEl.classList.remove('over');
  });
  trayEl.addEventListener('drop', (e) => {
    if (!trayAccepts(e) || busy) return;
    e.preventDefault();
    e.stopPropagation();
    trayEl.classList.remove('over');
    root.classList.remove('fx-over');
    const ids = e.dataTransfer!.getData(DRAG_TYPE);
    if (ids) addToTray(ids.split(',').map(Number));
    else void addFiles([...e.dataTransfer!.files], true);
  });

  ta.addEventListener('input', () => {
    dirty = true;
    const it = byId(shown)!;
    it.edited = true;
    refreshHl();
    scheduleMd();
    analyse(it.size > WARN_TEXT ? 600 : 150);
    paint();
  });
  ta.addEventListener('scroll', () => {
    syncHl();
    // Split view: keep the preview roughly at the same relative position.
    if (editorEl.dataset.mdView === 'split') {
      const f = ta.scrollTop / Math.max(1, ta.scrollHeight - ta.clientHeight);
      mdEl.scrollTop = f * (mdEl.scrollHeight - mdEl.clientHeight);
    }
    paint();
  });
  document.addEventListener('selectionchange', () => document.activeElement === ta && paint());
  new ResizeObserver(paint).observe(ta);
  ta.addEventListener('blur', () => (escaped = false));
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') escaped = true;
    else if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && !escaped) {
      e.preventDefault();
      insert('  ');
    } else if (e.key !== 'Shift') escaped = false;
  });

  // Shortcuts only while focus is inside the app, so the browser's own shortcuts keep working elsewhere.
  root.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && !e.shiftKey && !e.altKey && key === 's') {
      e.preventDefault();
      download();
    } else if (mod && e.shiftKey && !e.altKey && key === 'f') {
      e.preventDefault();
      void runJson('format');
    } else if (((mod && !e.shiftKey && key === 'w') || (e.altKey && !mod && e.code === 'KeyW')) && active !== undefined) {
      // Most browsers reserve Ctrl/Cmd+W; Alt+W always works.
      e.preventDefault();
      closeTab(active);
      focusAfterClose();
    } else if (active === DIFF && !mod && !(e.target as HTMLElement).matches('input, textarea, select') && ((!e.altKey && (key === 'n' || key === 'p')) || (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')))) {
      e.preventDefault();
      goChange(key === 'n' || e.key === 'ArrowDown' ? 1 : -1);
    } else if (active === undefined && e.key.length === 1 && !mod && !e.altKey && !(e.target as HTMLElement).matches('input, textarea, select')) {
      // Start typing on the empty state.
      e.preventDefault();
      newDoc(e.key);
    }
  });

  root.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    root.classList.add('fx-over');
  });
  root.addEventListener('dragleave', (e) => {
    if (!root.contains(e.relatedTarget as Node | null)) root.classList.remove('fx-over');
  });
  root.addEventListener('drop', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    root.classList.remove('fx-over');
    void addFiles([...e.dataTransfer.files]);
  });
  document.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files ?? [])];
    if (files.length) {
      e.preventDefault();
      return void addFiles(files);
    }
    // Text pasted outside an input field becomes a document.
    const text = e.clipboardData?.getData('text/plain');
    if (text && !(e.target as HTMLElement).matches?.('input, textarea')) {
      e.preventDefault();
      putText(text);
    }
  });

  if (narrow.matches) setExplorer(false);
  // Deep links: the top-bar tools, plus extract / 7z (archive tray presets) and markdown (a Split-view document).
  const mode = new URLSearchParams(location.search).get('mode');
  if (mode === 'extract' || mode === '7z') {
    if (mode === '7z') field('fmt"][value="7z').checked = true;
    else $('#fx-tray-help').textContent = 'Drop an archive to extract (ZIP, 7z, RAR, tar, gz, xz, bz2).';
    setTool('zip', true);
  } else setTool(TOOLS.includes(mode as Tool) ? (mode as Tool) : 'json', true);
  if (mode === 'markdown') {
    const text = '# Untitled\n\nWrite **Markdown** here; the preview on the right updates as you type.\n\n- [ ] Task lists, tables and `code` work too.\n';
    const it = addItem({ name: uniqueName(`Untitled-${++untitled}.md`), text, size: new Blob([text]).size, sniffed: 'unknown', generated: true, mdView: 'split' });
    mdPlaceholder = it.id;
    openItem(it.id);
  } else showActive();
}
