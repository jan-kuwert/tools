// Text app (src/pages/text/index.astro): explorer, tabbed text editor, JSON/JS tools, Markdown preview and compare.
import { formatJson, jsonError } from './json';
import { jsonErrorAt } from './json-locate';
import type * as Highlight from './highlight';
import type * as Markdown from './markdown';
import { diffLines, diffWords, sortJsonKeys } from './diff';
import { resizable } from './resize';
import { downloadBlob, el, formatBytes, sniff, UserError } from './tool';

type Kind = 'info' | 'ok' | 'warn' | 'error';
type Sniffed = 'jpeg' | 'png' | 'webp' | 'pdf' | 'gzip' | 'zip' | 'unknown';

interface Item {
  id: number;
  name: string;
  /** Present for text documents (editable). */
  text?: string;
  /** Original bytes; used as-is for downloads until the text is edited. */
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
  /** File type of a text document (a highlight.js language id): guessed on arrival, then the user's pick. */
  type?: string;
  /** The user chose the type; it is no longer re-guessed. */
  picked?: boolean;
  mdView?: 'edit' | 'split' | 'preview';
}

const MB = 1024 * 1024;
const MAX_TEXT = 50 * MB;
const WARN_TEXT = 5 * MB;
const MAX_JS = 10 * MB;
/** Folder drops stop here, so a huge tree cannot freeze the page. */
const MAX_FILES = 10_000;
const LINE = 20; // px; matches --fx-line
/** Tab id of the comparison view (items have positive ids). */
const DIFF = -1;
const INDENTS: Record<string, string> = { '2': '  ', '4': '    ', tab: '\t' };
const TYPE_LABEL: Record<Item['sniffed'], string> = {
  jpeg: 'JPEG image', png: 'PNG image', webp: 'WebP image', pdf: 'PDF document', gzip: 'Gzip archive', zip: 'ZIP archive', unknown: 'Binary data',
};

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

/** File types (highlight.js language ids); the first four have their own tools. */
const TYPES: Record<string, string> = {
  json: 'JSON', javascript: 'JavaScript', markdown: 'Markdown', plaintext: 'Plain text',
  typescript: 'TypeScript', xml: 'HTML / XML', css: 'CSS', python: 'Python', bash: 'Shell', sql: 'SQL', yaml: 'YAML',
};
/** Types with their own tool panel; every other type gets the plain-text panel. */
const PANELS = ['json', 'javascript', 'markdown'];
const EXT_TYPE: Record<string, string> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  json: 'json', jsonc: 'json', webmanifest: 'json', geojson: 'json', py: 'python', pyw: 'python', md: 'markdown', markdown: 'markdown',
  html: 'xml', htm: 'xml', xhtml: 'xml', xml: 'xml', svg: 'xml', css: 'css', sh: 'bash', bash: 'bash', zsh: 'bash', yml: 'yaml', yaml: 'yaml', sql: 'sql',
};
const MIME_TYPE: Record<string, string> = {
  'text/javascript': 'javascript', 'application/javascript': 'javascript', 'text/markdown': 'markdown', 'text/x-markdown': 'markdown',
  'text/html': 'xml', 'text/xml': 'xml', 'application/xml': 'xml', 'image/svg+xml': 'xml', 'text/css': 'css', 'text/x-python': 'python',
  'application/x-sh': 'bash', 'text/x-sh': 'bash', 'application/yaml': 'yaml', 'text/yaml': 'yaml', 'application/sql': 'sql',
};
const MD_HINT = /^(?:#{1,6} \S|```|(?:[-*+]|\d+\.) \S.*\n(?:[-*+]|\d+\.) \S)/m;
const JS_HINT =
  /^\s*(?:(?:const|let|var)\s+[\w${[]+\s*=|import\s+[\w${*'"]|export\s+(?:default|const|let|function|class|async|\{)|(?:async\s+)?function\b|class\s+[\w$]+[^\n]*\{)|[\w)]\s*=>|\brequire\(\s*['"]|\bconsole\.\w+\(/m;

/** First guess of a text document's type: extension, MIME type, shebang, then the content. */
function guessType(name: string, text: string, mime = ''): string {
  const ext = /\.([^./]+)$/.exec(name)?.[1].toLowerCase();
  if (ext && EXT_TYPE[ext]) return EXT_TYPE[ext];
  const m = mime.split(';')[0].trim().toLowerCase();
  if (/[/+]json$/.test(m)) return 'json';
  if (MIME_TYPE[m]) return MIME_TYPE[m];
  const head = text.slice(0, 8192);
  const shebang = /^#!.*\b(python|bash|sh|zsh|node)\b/.exec(head)?.[1];
  if (shebang) return shebang === 'python' ? 'python' : shebang === 'node' ? 'javascript' : 'bash';
  // Very large texts are not parsed just to guess.
  if (/^\s*[[{]/.test(head) && (text.length > WARN_TEXT || !jsonError(text))) return 'json';
  if (MD_HINT.test(head)) return 'markdown';
  if (JS_HINT.test(head)) return 'javascript';
  return 'plaintext';
}

const MIME_OF: Record<string, string> = { json: 'application/json', javascript: 'text/javascript', markdown: 'text/markdown;charset=utf-8' };
const blobOf = (it: Item): Blob =>
  it.blob && !it.edited ? it.blob : new Blob([it.text ?? ''], { type: it.text === undefined ? 'application/octet-stream' : (MIME_OF[it.type!] ?? 'text/plain;charset=utf-8') });
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

export function initTextApp(): void {
  const root = document.querySelector<HTMLElement>('[data-fx]')!;
  const $ = <T extends Element = HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  const $$ = <T extends Element = HTMLElement>(sel: string) => root.querySelectorAll<T>(sel);
  const input = $<HTMLInputElement>('[data-input]');
  // Two editor panes (split view). The editor code works on "the current pane": these refs and the per-pane
  // state below are swapped by usePane(); the other pane keeps showing what it last rendered.
  interface Pane {
    el: HTMLElement;
    ta: HTMLTextAreaElement;
    code: HTMLElement;
    gutter: HTMLElement;
    curline: HTMLElement;
    hex: HTMLElement;
    tabsEl: HTMLElement;
    hlCode: HTMLElement;
    mdEl: HTMLElement;
    editorEl: HTMLElement;
    open: number[];
    active?: number;
    shown?: number;
    dirty: boolean;
    lineCount: number;
    synTimer: number;
    mdTimer: number;
  }
  const panes: Pane[] = [...root.querySelectorAll<HTMLElement>('[data-pane]')].map((el) => {
    const q = <T extends Element = HTMLElement>(sel: string) => el.querySelector<T>(sel)!;
    return {
      el, ta: q<HTMLTextAreaElement>('[data-text]'), code: q('[data-code]'), gutter: q('[data-gutter]'), curline: q('[data-curline]'), hex: q('[data-hex]'),
      tabsEl: q('[data-tabs]'), hlCode: q('[data-hl]'), mdEl: q('[data-md]'), editorEl: q('[data-editor]'),
      open: [], dirty: false, lineCount: 1, synTimer: 0, mdTimer: 0,
    };
  });
  let pane = panes[0];
  let { ta, code, gutter, curline, hex, tabsEl, hlCode, mdEl, editorEl } = pane;
  /** The Tools sidebar follows the active pane; work done in the other pane (withPane) leaves it alone. */
  const leads = () => pane.el.hasAttribute('data-active');
  /** Query inside the current pane. */
  const $p = <T extends Element = HTMLElement>(sel: string) => pane.el.querySelector<T>(sel)!;
  const empty = $('[data-empty-state]');
  const filesEl = $<HTMLUListElement>('[data-files]');
  const out = $<HTMLOListElement>('[data-out]');
  const outToggle = $<HTMLButtonElement>('[data-out-toggle]');
  const explorer = $('#fx-explorer');
  const explorerToggle = $<HTMLButtonElement>('[data-toggle-explorer]');
  const toolbox = $('#fx-tools');
  const toolsToggle = $<HTMLButtonElement>('[data-toggle-tools]');
  const typeSelect = $<HTMLSelectElement>('[data-type]');
  const compareSec = $<HTMLDetailsElement>('[data-compare-sec]');
  const selectAll = $<HTMLInputElement>('[data-select-all]');
  const msg = $('[data-msg]');
  const progress = $<HTMLProgressElement>('[data-progress]');
  const icons = $<HTMLTemplateElement>('[data-icons]');
  const icon = (name: string) => icons.content.querySelector(`[data-i="${name}"]`)!.firstElementChild!.cloneNode(true);
  const field = <T extends HTMLInputElement>(name: string) => root.querySelector<T>(`[name="${name}"]`)!;
  const checkedValue = (name: string) => root.querySelector<HTMLInputElement>(`[name="${name}"]:checked`)!.value;
  const narrow = matchMedia('(max-width: 760px)');
  /** Sidebars become drawers over the editor. */
  const drawers = matchMedia('(max-width: 860px)');
  const tiny = matchMedia('(max-width: 480px)');
  const delDialog = $<HTMLDialogElement>('[data-del-dialog]');
  const splitArea = $('[data-split-area]');
  const seam = $<HTMLButtonElement>('[data-seam-compare]');
  const outPanel = $('[data-out-panel]');

  let items: Item[] = [];
  let open: number[] = pane.open;
  let active: number | undefined;
  const ticked = new Set<number>();
  let anchor: number | undefined;
  let roving: number | undefined;
  let nextId = 1;
  let untitled = 0;
  let shown: number | undefined; // item currently loaded in the textarea
  let dirty = false; // textarea differs from that item's text
  let lineCount = 1;
  let synTimer = 0;
  let escaped = false;
  let busy = false;
  /** ?mode=json|js: type of new untitled documents. */
  let defaultType: string | undefined;

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

  /** Make `p` the pane the editor code works on (no focus or UI change). */
  function usePane(p: Pane) {
    if (p === pane) return;
    Object.assign(pane, { open, active, shown, dirty, lineCount, synTimer });
    pane = p;
    ({ ta, code, gutter, curline, hex, tabsEl, hlCode, mdEl, editorEl } = p);
    ({ open, active, shown, dirty, lineCount, synTimer } = p);
  }
  /** Run `fn` against another pane, then switch back. */
  function withPane(p: Pane, fn: () => void) {
    const back = pane;
    usePane(p);
    try {
      fn();
    } finally {
      usePane(back);
    }
  }

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
      paintNow();
    });
  }
  /** Gutter numbers, current-line band and Ln/Col for the current pane. */
  function paintNow() {
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
    $p('[data-sb-pos]').textContent = `Ln ${line}, Col ${col}${selLen ? ` (${selLen} selected)` : ''}`;
  }

  function measureLines(t: string) {
    let n = 1;
    for (let i = t.indexOf('\n'); i !== -1; i = t.indexOf('\n', i + 1)) n++;
    lineCount = n;
    code.style.setProperty('--fx-gw', `${Math.max(3, String(n).length) + 1}ch`);
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
        measureLines(t);
        if (it.edited) it.size = new Blob([t]).size;
        if (it.type === 'json') {
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
    $p('[data-sb-size]').textContent = it ? formatBytes(it.size) : '';
    const sbType = $p<HTMLButtonElement>('[data-sb-type]');
    sbType.hidden = !it;
    sbType.disabled = !text;
    sbType.textContent = !it ? '' : text ? TYPES[it.type!] : 'Binary';
    if (!text) $p('[data-sb-pos]').textContent = '';
    if (!text || !leads()) return;
    if (it.type === 'json') {
      const jsonState = $<HTMLButtonElement>('[data-json-state]');
      const state = !it.text!.trim() ? 'empty' : it.json ? (it.json.ok ? 'valid' : 'invalid') : 'unknown';
      jsonState.dataset.state = state;
      jsonState.disabled = state === 'empty';
      jsonState.replaceChildren(icon(state === 'invalid' ? 'warning' : 'check'), { valid: 'Valid JSON', invalid: 'Invalid JSON', unknown: 'Check JSON', empty: 'Empty' }[state]);
      jsonState.title = state === 'invalid' ? `Go to the error: ${it.json!.message}` : 'Validate JSON';
      $('[data-json-size]').textContent = formatBytes(it.size);
    } else if (!PANELS.includes(it.type!)) {
      let words = 0;
      for (const _ of it.text!.matchAll(/\S+/g)) words++;
      $('[data-count-words]').textContent = words.toLocaleString();
      $('[data-count-lines]').textContent = lineCount.toLocaleString();
      $('[data-count-chars]').textContent = it.text!.length.toLocaleString();
    }
  }

  // ---- Highlighting (overlay) and Markdown preview; both modules load on first need ----
  const HL_MAX = 300 * 1024;
  let hl: typeof Highlight | undefined;
  let md: typeof Markdown | undefined;
  // Lazy on purpose: highlight.js only downloads when a highlighted language is first shown.
  const loadHl = () => import('./highlight').then((m) => (hl = m));

  function syncHl() {
    hlCode.style.transform = `translate(${-ta.scrollLeft}px, ${-ta.scrollTop}px)`;
  }

  /** Redraws the overlay; small documents synchronously, larger ones after a short pause in typing. */
  function refreshHl(now = false) {
    const it = curText();
    const syntax = it?.type ?? 'plaintext';
    const large = ta.value.length >= HL_MAX;
    const want = !!it && !code.hidden && syntax !== 'plaintext' && !large;
    $p('[data-sb-hl]').textContent = it && syntax !== 'plaintext' && large ? 'Highlighting off (large file)' : '';
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

  /** Markdown preview visibility for the active document (and the sidebar's view switch). */
  function renderMdChrome() {
    const it = curText();
    const view = it?.type === 'markdown' ? (it.mdView ?? 'edit') : 'edit';
    if (leads()) root.querySelector<HTMLInputElement>(`[name="mdView"][value="${view}"]`)!.checked = true;
    if (view === 'edit') delete editorEl.dataset.mdView;
    else editorEl.dataset.mdView = view;
    if (it) code.hidden = view === 'preview';
    mdEl.hidden = view === 'edit';
    if (!mdEl.hidden) scheduleMd(true);
  }

  function scheduleMd(now = false) {
    const p = pane;
    const it = curText();
    if (!it || mdEl.hidden) return;
    clearTimeout(p.mdTimer);
    const timer = window.setTimeout(
      async () => {
        // Lazy on purpose: micromark + GFM only download when a preview is first shown.
        md ??= await import('./markdown');
        if (p.mdTimer !== timer || p.el.hidden) return;
        withPane(p, () => {
          if (curText() !== it || it.type !== 'markdown' || mdEl.hidden) return;
          sync();
          const top = mdEl.scrollTop;
          mdEl.replaceChildren(md!.renderMarkdown(it.text!));
          mdEl.scrollTop = top;
        });
      },
      now ? 0 : 150,
    );
    p.mdTimer = timer;
  }

  /** After a document's type changed: highlighting, preview, icons and the tools follow. */
  function applyType() {
    renderMdChrome();
    refreshHl(true);
    renderTabs();
    renderExplorer();
    renderTools();
    analyse();
  }

  /** An empty document that receives pasted or dropped text gets its type guessed again (unless the user chose one). */
  function retype(it: Item, text: string) {
    const t = guessType(it.name, text);
    if (it.picked || t === 'plaintext' || t === it.type) return;
    it.type = t;
    applyType();
  }

  typeSelect.append(...Object.entries(TYPES).map(([value, label]) => el('option', { value, textContent: label })));
  typeSelect.addEventListener('change', () => {
    const it = curText();
    if (!it) return;
    it.type = typeSelect.value;
    it.picked = true;
    applyType();
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
    // The empty state and the comparison view exist in the first pane only.
    if (pane === panes[0]) {
      empty.hidden = !!it || diffing;
      $('[data-diff]').hidden = !diffing;
    }
    code.hidden = it?.text === undefined;
    hex.hidden = !it || it.text !== undefined;
    editorEl.setAttribute('aria-labelledby', active !== undefined ? tabId(active) : '');
    if (it?.text !== undefined) {
      if (shown !== it.id) {
        shown = it.id;
        ta.value = it.text;
        const v = it.view;
        ta.setSelectionRange(v?.start ?? 0, v?.end ?? 0, v?.dir);
        ta.scrollTop = v?.top ?? 0;
        ta.scrollLeft = v?.left ?? 0;
        // Gutter width and line count now, so a pane rendered in the background is complete too.
        measureLines(it.text);
        paintNow();
      }
    } else {
      shown = undefined;
      ta.value = '';
      if (it) {
        const token = String(++hexToken);
        const blob = blobOf(it);
        const info = $p('[data-info]');
        const rows: [string, string][] = [['Name', it.name], ['Size', `${formatBytes(it.size)} (${it.size.toLocaleString()} bytes)`], ['Type', TYPE_LABEL[it.sniffed]]];
        if (it.note) rows.push(['Note', it.note]);
        rows.push(['Preview', blob.size > 4096 ? 'First 4 KB, hexadecimal' : 'Hexadecimal']);
        info.replaceChildren(...rows.flatMap(([k, v]) => [el('dt', { textContent: k }), el('dd', { textContent: v })]));
        const dump = $p('[data-hexdump]');
        dump.textContent = '';
        dump.dataset.token = token;
        void blob
          .slice(0, 4096)
          .arrayBuffer()
          .then((buf) => {
            if (dump.dataset.token === token) dump.textContent = hexDump(new Uint8Array(buf));
          });
      }
    }
    renderMdChrome();
    refreshHl(true);
    renderTabs();
    renderExplorer();
    renderTools();
    analyse();
    renderSplitChrome();
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
    if (drawers.matches && !stay) setExplorer(false);
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
    // The second pane only exists while it shows something.
    if (pane === panes[1] && !open.length) queueMicrotask(closeSplit);
  }

  function removeItem(id: number) {
    closeTab(id);
    for (const p of panes) if (p !== pane && p.open.includes(id)) withPane(p, () => closeTab(id));
    items = items.filter((it) => it.id !== id);
    ticked.delete(id);
    if (roving === id) roving = undefined;
    renderExplorer();
    renderTools();
  }

  /** Explorer removal: files with content ask first, empty ones go at once. */
  function confirmRemove(id: number) {
    const it = byId(id);
    if (!it) return;
    sync();
    const back = document.activeElement as HTMLElement | null;
    const remove = () => {
      removeItem(id);
      filesEl.querySelector<HTMLElement>('.fx-open[tabindex="0"]')?.focus();
    };
    if (it.text !== undefined ? it.text === '' : it.size === 0) return remove();
    $('[data-del-title]').textContent = `Delete ${it.name}?`;
    delDialog.returnValue = '';
    delDialog.addEventListener('close', () => (delDialog.returnValue === 'delete' && byId(id) ? remove() : back?.focus()), { once: true });
    delDialog.showModal();
  }

  function addItem(props: Omit<Item, 'id' | 'edited' | 'mtime'> & { mtime?: number }): Item {
    const type = props.type ?? (props.text === undefined ? undefined : guessType(props.name, props.text, props.blob?.type));
    const it: Item = { mtime: Date.now(), ...props, type, id: nextId++, edited: false };
    items.push(it);
    return it;
  }

  function newDoc(text = '') {
    const it = addItem({ name: uniqueName(`Untitled-${++untitled}`), text, size: new Blob([text]).size, sniffed: 'unknown', generated: true });
    if (defaultType && it.type === 'plaintext') it.type = defaultType;
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
      retype(it, text);
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
    if (it.type === 'json') return 'braces';
    if (it.type === 'javascript' || it.type === 'typescript') return 'code';
    if (it.text !== undefined) return 'doc';
    return ({ jpeg: 'images', png: 'images', webp: 'images', pdf: 'pdf', unknown: 'doc' } as Record<string, string>)[it.sniffed] ?? 'files';
  };
  // Folder prefixes (from folder drops) are shown muted before the file name.
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
        const row = el('li', { className: 'fx-row' });
        row.dataset.id = String(it.id);
        row.dataset.kind = it.type ?? 'binary';
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
        acts.append(btn('download', 'Download', () => {
          for (const p of panes) withPane(p, sync);
          downloadBlob(blobOf(it), it.name);
        }), btn('trash', 'Remove', () => confirmRemove(it.id)));
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
      // Path separators would read as folder prefixes.
      const name = field.value.trim().replace(/[\\/]+/g, '-');
      if (save && name && name !== it.name) {
        it.name = uniqueName(name);
        // A known extension sets the type, unless the user picked one.
        const ext = EXT_TYPE[/\.([^./]+)$/.exec(it.name)?.[1].toLowerCase() ?? ''];
        if (ext && !it.picked && it.text !== undefined) it.type = ext;
      }
      applyType();
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
    else if (e.key === 'Delete' && t.classList.contains('fx-open')) confirmRemove(id);
    else return;
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
  const tabId = (id: number) => `fx-tab-${panes.indexOf(pane)}-${id}`;
  function renderTabs() {
    const hadFocus = tabsEl.contains(document.activeElement);
    tabsEl.replaceChildren(
      ...open.map((id) => {
        const it = byId(id);
        const x = el('span', { className: 'fx-tab-x', title: 'Close' }, icon('xmark'));
        x.dataset.x = '';
        x.ariaHidden = 'true';
        const tab = el('button', { type: 'button', className: 'fx-tab', id: tabId(id), tabIndex: id === active ? 0 : -1 }, icon(it ? kindIcon(it) : 'compare'), el('span', { className: 'fx-tab-name', textContent: it?.name ?? diffTitle() }), x);
        tab.role = 'tab';
        tab.ariaSelected = String(id === active);
        tab.setAttribute('aria-controls', editorEl.id);
        tab.dataset.id = String(id);
        return tab;
      }),
    );
    const sel = tabsEl.querySelector<HTMLElement>('[aria-selected="true"]');
    if (sel) {
      tabsEl.scrollLeft = Math.min(Math.max(tabsEl.scrollLeft, sel.offsetLeft + sel.offsetWidth - tabsEl.clientWidth), sel.offsetLeft);
      if (hadFocus) sel.focus();
    }
    $p<HTMLButtonElement>('[data-close]').disabled = !cur();
  }
  for (const p of panes) {
    /** Tab whose close button the event hit, when that closes it now; tiny screens select an inactive tab first. */
    const closing = (e: Event) => {
      const t = e.target as HTMLElement;
      const tab = t.closest<HTMLElement>('.fx-tab');
      if (!tab || !t.closest('[data-x]')) return;
      const id = Number(tab.dataset.id);
      return tiny.matches && id !== paneActive(p) ? undefined : id;
    };
    // Closing never selects the tab or moves focus, also not in the other split pane.
    p.tabsEl.addEventListener('pointerdown', (e) => {
      if (closing(e) === undefined) return;
      e.preventDefault();
      e.stopPropagation();
    });
    p.tabsEl.addEventListener('click', (e) => {
      const id = closing(e);
      if (id !== undefined) {
        e.stopPropagation();
        withPane(p, () => closeTab(id));
        return renderExplorer();
      }
      const tab = (e.target as HTMLElement).closest<HTMLElement>('.fx-tab');
      activatePane(p);
      if (tab) openItem(Number(tab.dataset.id));
    });
    p.tabsEl.addEventListener('auxclick', (e) => {
      activatePane(p);
      const tab = (e.target as HTMLElement).closest<HTMLElement>('.fx-tab');
      if (tab && e.button === 1) closeTab(Number(tab.dataset.id));
    });
    p.tabsEl.addEventListener('keydown', (e) => {
      activatePane(p);
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
        tabsEl.querySelector<HTMLElement>(`#${tabId(open[next])}`)?.focus();
      }
    });
  }
  const focusAfterClose = () => (tabsEl.querySelector<HTMLElement>('[aria-selected="true"]') ?? $p('[data-tab-new]')).focus();

  // ---- Tools sidebar: File type, the panel for that type, Document and Compare ----
  function renderTools() {
    if (!leads()) return;
    const it = cur();
    const text = it?.text !== undefined;
    typeSelect.disabled = !text;
    if (text) typeSelect.value = it.type!;
    else typeSelect.selectedIndex = -1;
    $('[data-type-note]').textContent = active === DIFF ? 'Comparison view.' : !it ? 'Open, paste or create a document to see its tools.' : !text ? `${TYPE_LABEL[it.sniffed]}: no text tools.` : '';
    const panel = text ? (PANELS.includes(it.type!) ? it.type : 'text') : undefined;
    $$('[data-panel]').forEach((p) => (p.hidden = p.dataset.panel !== panel));
    ['validate', 'minify-json', 'format', 'minify-js'].forEach((a) => ($<HTMLButtonElement>(`[data-act="${a}"]`).disabled = busy || !text));
    $<HTMLButtonElement>('[data-copy]').disabled = !text;
    $<HTMLButtonElement>('[data-download]').disabled = !it;
    renderCompareChoices();
  }

  /** Show the Compare section (and the Tools sidebar on wide screens). */
  function openCompare() {
    compareSec.open = true;
    if (!drawers.matches) setTools(true);
  }

  const plural = (n: number, word = 'file') => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

  function startBusy(text: string) {
    busy = true;
    say(text);
    progress.hidden = false;
    progress.removeAttribute('value');
    renderTools();
  }
  function endBusy() {
    busy = false;
    progress.hidden = true;
    renderTools();
  }

  function fail(err: unknown) {
    if (!(err instanceof UserError)) console.error(err);
    log('error', err instanceof UserError ? err.message : `Something went wrong: ${(err as Error).message ?? err}`);
  }

  function addOutput(name: string, text: string) {
    const it = addItem({ name: uniqueName(name), text, size: new Blob([text]).size, sniffed: 'unknown', generated: true });
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
      const o = addOutput(`${stem(it.name)}${minify ? '.min' : ''}.json`, result);
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
      const o = addOutput(it.name.replace(/(\.[cm]?js)?$/i, (ext) => `.min${ext || '.js'}`), result);
      const pct = it.size ? Math.round((1 - o.size / it.size) * 100) : 0;
      const gz = (await new Response(new Blob([result]).stream().pipeThrough(new CompressionStream('gzip'))).blob()).size;
      log('ok', `Minified ${it.name} → ${o.name}: ${formatBytes(it.size)} → ${formatBytes(o.size)} (${pct >= 0 ? `${pct}% smaller` : `${-pct}% larger`}) · gzip ≈ ${formatBytes(gz)}.`);
    } catch (err) {
      fail(err);
    } finally {
      if (busy) endBusy();
    }
  }

  // ---- Files in: picker, hub hand-over, drop, paste ----
  /** UTF-8 text up to MAX_TEXT becomes an editable document, anything else a binary file. */
  async function addFile(file: File): Promise<Item> {
    const sniffed = await sniff(file);
    const text = sniffed === 'unknown' ? await decodeText(file, MAX_TEXT) : null;
    let note: string | undefined;
    if (text === null && sniffed === 'unknown') note = file.size > MAX_TEXT ? `Larger than ${formatBytes(MAX_TEXT)}, so it is not opened as text.` : 'Not UTF-8 text, so it is shown as binary.';
    if (text !== null && file.size > WARN_TEXT) log('warn', `${file.name} is ${formatBytes(file.size)}: the editor may be slow.`);
    return addItem({ name: file.name, text: text ?? undefined, blob: file, size: file.size, sniffed, generated: false, mtime: file.lastModified, note });
  }

  async function addFiles(files: File[]) {
    const added: Item[] = [];
    for (const f of files) added.push(await addFile(f));
    if (!added.length) return;
    // ?mode=markdown: the first Markdown file replaces the untouched placeholder and opens in Split view.
    const md = mdPlaceholder !== undefined ? added.find((it) => it.type === 'markdown') : undefined;
    if (md) {
      md.mdView = 'split';
      if (!byId(mdPlaceholder)?.edited) removeItem(mdPlaceholder!);
      mdPlaceholder = undefined;
    }
    openItem((md ?? added[0]).id);
    say(`Added ${plural(added.length)}.`);
  }
  let mdPlaceholder: number | undefined;

  /** Files of a drop; folders (directory entries) contribute every file inside, named by their relative path. */
  async function droppedFiles(dt: DataTransfer): Promise<File[]> {
    // Entries and files must be read before the first await: the DataTransfer is emptied after the event.
    const entries = [...dt.items].map((i) => i.webkitGetAsEntry()).filter((x): x is FileSystemEntry => !!x);
    const plain = [...dt.files];
    if (!entries.some((x) => x.isDirectory)) return plain;
    const files: File[] = [];
    const walk = async (entry: FileSystemEntry): Promise<void> => {
      if (files.length > MAX_FILES) throw new UserError(`The drop holds more than ${plural(MAX_FILES)}; drop a smaller folder.`);
      if (entry.isFile) {
        const { promise, resolve, reject } = Promise.withResolvers<File>();
        (entry as FileSystemFileEntry).file(resolve, reject);
        const file = await promise;
        const path = entry.fullPath.replace(/^\/+/, '');
        files.push(path && path !== file.name ? new File([file], path, { type: file.type, lastModified: file.lastModified }) : file);
      } else if (entry.isDirectory) {
        const reader = (entry as FileSystemDirectoryEntry).createReader();
        // readEntries returns batches until an empty one.
        for (;;) {
          const { promise, resolve, reject } = Promise.withResolvers<FileSystemEntry[]>();
          reader.readEntries(resolve, reject);
          const batch = await promise;
          if (!batch.length) break;
          for (const e of batch) await walk(e);
        }
      }
    };
    for (const e of entries) await walk(e);
    return files;
  }

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

  // On narrow screens the sidebars are drawers over the editor; only one is open at a time.
  function setExplorer(show: boolean) {
    explorer.hidden = !show;
    explorerToggle.ariaExpanded = String(show);
    if (show && drawers.matches) setTools(false);
  }
  function setTools(show: boolean) {
    toolbox.hidden = !show;
    toolsToggle.ariaExpanded = String(show);
    if (show && drawers.matches) setExplorer(false);
  }

  // ---- Wiring ----
  input.addEventListener('change', () => {
    const files = [...(input.files ?? [])];
    input.value = '';
    void addFiles(files);
  });
  $$('[data-open]').forEach((b) => b.addEventListener('click', () => input.click()));
  $$('[data-new]').forEach((b) => b.addEventListener('click', () => newDoc()));
  $$('[data-paste]').forEach((b) => b.addEventListener('click', () => void pasteFromClipboard()));
  explorerToggle.onclick = () => setExplorer(explorerToggle.ariaExpanded !== 'true');
  toolsToggle.onclick = () => setTools(toolsToggle.ariaExpanded !== 'true');
  drawers.addEventListener('change', () => {
    setExplorer(!drawers.matches);
    setTools(!drawers.matches);
  });
  $('.fx-main').addEventListener('pointerdown', () => {
    if (!drawers.matches) return;
    setExplorer(false);
    setTools(false);
  });
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
  $<HTMLButtonElement>('[data-json-state]').onclick = () => {
    const it = cur();
    if (it?.json?.line) jumpTo(it.id, it.json.line, it.json.col!);
    else void runJson('validate');
  };
  for (const p of panes) {
    // Clicking or focusing anywhere in a pane makes it the one actions apply to.
    p.el.addEventListener('focusin', () => activatePane(p));
    p.el.addEventListener('pointerdown', () => activatePane(p));
    p.el.querySelector('[data-close]')!.addEventListener('click', () => {
      activatePane(p);
      if (active !== undefined) closeTab(active);
      focusAfterClose();
    });
    p.el.querySelector('[data-tab-new]')!.addEventListener('click', () => {
      activatePane(p);
      newDoc();
    });
    p.el.querySelector('[data-sb-type]')!.addEventListener('click', () => {
      activatePane(p);
      setTools(true);
      typeSelect.focus();
    });
  }
  outToggle.onclick = () => setOutOpen(outToggle.ariaExpanded !== 'true');
  $('[data-out-clear]').addEventListener('click', () => {
    out.replaceChildren();
    say('');
    renderProblemCount();
    setOutOpen(false);
    outPanel.hidden = true;
  });
  // ---- Split editor ----
  let split: 'right' | 'down' | undefined;
  const splitSize: Partial<Record<'right' | 'down', number>> = {};
  const paneActive = (p: Pane) => (p === pane ? active : p.active);

  /** Make `p` the pane actions apply to; its document is reloaded if the other pane edited it meanwhile. */
  function activatePane(p: Pane) {
    if (p === pane || p.el.hidden) return;
    saveView();
    sync();
    pane.el.removeAttribute('data-active');
    usePane(p);
    p.el.setAttribute('data-active', '');
    const it = byId(shown);
    if (it?.text !== undefined && it.text !== ta.value) shown = undefined;
    showActive();
  }

  function setSplit(dir: 'right' | 'down') {
    // Side by side is too narrow on phones.
    if (narrow.matches) dir = 'down';
    const [a, b] = panes;
    if (!split) {
      const aActive = paneActive(a);
      const aOpen = a === pane ? open : a.open;
      // The second pane starts with another open document, another text file, or the same one.
      const pick = aOpen.find((id) => id !== aActive && id !== DIFF) ?? items.find((it) => it.id !== aActive && it.text !== undefined)?.id ?? (aActive !== DIFF ? aActive : undefined);
      if (pick === undefined) return say('Open a file first, then split the editor.', 'error');
      Object.assign(b, { open: [pick], active: pick, shown: undefined, dirty: false });
    }
    split = dir;
    splitArea.dataset.split = dir;
    b.el.hidden = false;
    $$<HTMLElement>('[data-split-handle]').forEach((h) => (h.hidden = h.dataset.splitHandle !== dir));
    ensureSplitResizer(dir);
    if (splitSize[dir]) splitArea.style.setProperty('--fx-split', `${splitSize[dir]}px`);
    withPane(b, showActive);
    renderSplitChrome();
  }

  function closeSplit() {
    if (!split) return;
    const [a, b] = panes;
    activatePane(a);
    // Documents open in the second pane move over as tabs.
    for (const id of b.open) if (!open.includes(id) && (byId(id) || id === DIFF)) open.push(id);
    Object.assign(b, { open: [], active: undefined, shown: undefined, dirty: false });
    b.el.hidden = true;
    split = undefined;
    delete splitArea.dataset.split;
    $$<HTMLElement>('[data-split-handle]').forEach((h) => (h.hidden = true));
    showActive();
    renderSplitChrome();
  }

  /** Split buttons' pressed state and the seam "Compare" pill (two different text documents visible). */
  function renderSplitChrome() {
    $$<HTMLButtonElement>('[data-split-btn]').forEach((btn) => {
      btn.ariaPressed = String(split === btn.dataset.splitBtn);
      btn.disabled = !split && !items.length;
    });
    const [x, y] = panes.map((p) => byId(paneActive(p)));
    seam.hidden = !split || !x || !y || x === y || x.text === undefined || y.text === undefined;
  }

  const splitResizers: Partial<Record<'right' | 'down', true>> = {};
  function ensureSplitResizer(dir: 'right' | 'down') {
    if (splitResizers[dir]) return;
    splitResizers[dir] = true;
    const right = dir === 'right';
    const size = () => (right ? splitArea.clientWidth : splitArea.clientHeight);
    resizable($(`[data-split-handle="${dir}"]`), {
      key: right ? 'files.split' : 'files.split.down',
      min: () => 160,
      max: () => Math.max(160, size() - 160),
      initial: Math.round(size() / 2),
      apply: (v) => {
        splitSize[dir] = v;
        if (split === dir) splitArea.style.setProperty('--fx-split', `${v}px`);
      },
      // Size of the first pane: from the area's left (or top) edge to the pointer.
      fromPointer: (e) => {
        const r = splitArea.getBoundingClientRect();
        return right ? e.clientX - r.left : e.clientY - r.top;
      },
      growKey: right ? 'ArrowRight' : 'ArrowDown',
      shrinkKey: right ? 'ArrowLeft' : 'ArrowUp',
      container: splitArea,
    });
  }

  $$<HTMLButtonElement>('[data-split-btn]').forEach((btn) =>
    btn.addEventListener('click', () => (split === btn.dataset.splitBtn ? closeSplit() : setSplit(btn.dataset.splitBtn as 'right' | 'down'))),
  );
  $('[data-split-close]').addEventListener('click', closeSplit);
  narrow.addEventListener('change', () => split === 'right' && narrow.matches && setSplit('down'));
  seam.addEventListener('click', () => {
    const [x, y] = panes.map((p) => byId(paneActive(p))!);
    closeSplit();
    openCompare();
    root.querySelector<HTMLSelectElement>('[name="cmpA"]')!.value = String(x.id);
    root.querySelector<HTMLSelectElement>('[name="cmpB"]')!.value = String(y.id);
    void compare({ name: x.name, id: x.id }, { name: y.name, id: y.id });
  });
  const acts: Record<string, () => void> = {
    validate: () => runJson('validate'),
    'minify-json': () => runJson('minify'),
    format: () => runJson('format'),
    'minify-js': runJs,
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
    normJson.hidden = !(a?.type === 'json' || b?.type === 'json');
  }
  const normJson = $('[data-norm-json]');
  $$('[name="cmpA"], [name="cmpB"]').forEach((s) => s.addEventListener('change', renderCompareChoices));

  async function compare(a: Source, b: Source) {
    // The comparison view lives in the first pane.
    const p = panes[0];
    activatePane(p);
    const sources = diffSrc = { a, b };
    saveView();
    if (!open.includes(DIFF)) open.push(DIFF);
    active = DIFF;
    showActive();
    say('Comparing…');
    const painted = Promise.withResolvers<void>();
    requestAnimationFrame(() => setTimeout(painted.resolve));
    await painted.promise;
    if (diffSrc !== sources) return;
    withPane(p, () => {
      if (!open.includes(DIFF)) return;
      renderDiff();
      if (active === DIFF && leads()) diffBody.focus({ preventScroll: true });
    });
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
    if (field('normJson').checked && !normJson.hidden) {
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
    openCompare();
    void compare({ name: a.name, id: a.id }, { name: b.name, id: b.id });
  });

  // ---- Resizable sidebars and Output panel ----
  resizable($('[data-resize-side]'), {
    key: 'files.explorer',
    min: () => 180,
    max: () => Math.max(180, Math.round(root.clientWidth / 3)),
    initial: 260,
    apply: (v) => root.style.setProperty('--fx-sw', `${v}px`),
    // The handle sits on the Explorer's right edge and the Explorer starts at the app's left edge.
    fromPointer: (e) => e.clientX - root.getBoundingClientRect().left,
    growKey: 'ArrowRight',
    shrinkKey: 'ArrowLeft',
    container: root,
  });
  resizable($('[data-resize-tools]'), {
    key: 'text-tools',
    min: () => 220,
    max: () => Math.max(220, Math.round(root.clientWidth / 3)),
    initial: 280,
    apply: (v) => root.style.setProperty('--fx-tw', `${v}px`),
    // The handle sits on the Tools sidebar's left edge and the sidebar ends at the app's right edge.
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
  $('[data-sel-clear]').addEventListener('click', () => {
    ticked.clear();
    renderExplorer();
    renderTools();
    filesEl.querySelector<HTMLElement>('.fx-open[tabindex="0"]')?.focus();
  });

  for (const p of panes) {
    p.ta.addEventListener('input', (e) => {
      activatePane(p);
      dirty = true;
      const it = byId(shown)!;
      it.edited = true;
      if (!it.text && /^insertFrom(Paste|Drop)/.test((e as InputEvent).inputType)) retype(it, ta.value);
      refreshHl();
      scheduleMd();
      analyse(it.size > WARN_TEXT ? 600 : 150);
      paint();
    });
    p.ta.addEventListener('scroll', () => {
      // The other pane scrolls too (wheel without focus): keep its overlay and gutter in step.
      if (p !== pane) {
        withPane(p, () => {
          syncHl();
          paintNow();
        });
        return;
      }
      syncHl();
      // Markdown split view: keep the preview roughly at the same relative position.
      if (editorEl.dataset.mdView === 'split') {
        const f = ta.scrollTop / Math.max(1, ta.scrollHeight - ta.clientHeight);
        mdEl.scrollTop = f * (mdEl.scrollHeight - mdEl.clientHeight);
      }
      paint();
    });
    p.ta.addEventListener('blur', () => (escaped = false));
    p.ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') escaped = true;
      else if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && !escaped) {
        e.preventDefault();
        insert('  ');
      } else if (e.key !== 'Shift') escaped = false;
    });
  }
  document.addEventListener('selectionchange', () => document.activeElement === ta && paint());
  // Gutters follow pane size changes (window, Explorer or split divider), in both panes.
  const paneResize = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const p = panes.find((x) => x.ta === entry.target);
      if (p && !p.el.hidden) withPane(p, paintNow);
    }
  });
  panes.forEach((p) => paneResize.observe(p.ta));

  // Shortcuts only while focus is inside the app, so the browser's own shortcuts keep working elsewhere.
  root.addEventListener('keydown', (e) => {
    if (delDialog.open) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && !e.shiftKey && !e.altKey && key === 's') {
      e.preventDefault();
      download();
    } else if (mod && e.altKey && !e.shiftKey && (key === 'n' || (e.metaKey && e.code === 'KeyN'))) {
      // Ctrl/Cmd+Alt+N: AltGr+N (Ctrl+Alt on some layouts) types a letter such as "ń", so key must be "n".
      e.preventDefault();
      newDoc();
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

  // The whole app surface takes file drops (capture phase, so no child can swallow them). A depth count keeps the
  // highlight steady while the pointer crosses child elements.
  let dragDepth = 0;
  const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');
  root.addEventListener(
    'dragenter',
    (e) => {
      if (!hasFiles(e)) return;
      dragDepth++;
      root.classList.add('fx-over');
    },
    true,
  );
  root.addEventListener(
    'dragleave',
    (e) => {
      if (!hasFiles(e) || --dragDepth > 0) return;
      dragDepth = 0;
      root.classList.remove('fx-over');
    },
    true,
  );
  root.addEventListener(
    'dragover',
    (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = 'copy';
    },
    true,
  );
  root.addEventListener(
    'drop',
    (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      dragDepth = 0;
      root.classList.remove('fx-over');
      droppedFiles(e.dataTransfer!).then(addFiles).catch(fail);
    },
    true,
  );
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

  if (drawers.matches) {
    setExplorer(false);
    setTools(false);
  }
  // Deep links and hub mode changes preserve documents already open in this frame.
  function applyMode(mode: string | null) {
    defaultType = mode === 'json' ? 'json' : mode === 'js' ? 'javascript' : mode === 'markdown' ? 'markdown' : undefined;
    if (mode === 'compare') {
      compareSec.open = true;
      setTools(true);
    }
    if (mode === 'markdown') {
      const current = curText();
      const existing = current?.type === 'markdown' ? current : items.find((it) => it.type === 'markdown' && it.text !== undefined);
      if (existing) {
        existing.mdView ??= 'split';
        openItem(existing.id);
      } else {
        const text = '# Untitled\n\nWrite **Markdown** here; the preview on the right updates as you type.\n\n- [ ] Task lists, tables and `code` work too.\n';
        const it = addItem({ name: uniqueName(`Untitled-${++untitled}.md`), text, size: new Blob([text]).size, sniffed: 'unknown', generated: true, mdView: 'split' });
        mdPlaceholder = it.id;
        openItem(it.id);
      }
    } else showActive();
  }
  window.addEventListener('tools:mode', (event) => applyMode((event as CustomEvent<string | null>).detail));
  applyMode(new URLSearchParams(location.search).get('mode'));
}
