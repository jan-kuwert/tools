// Files & text app (src/pages/files/index.astro): explorer, tabbed text editor, JSON/JS/ZIP/gzip actions.
import { Gunzip, Gzip, gzipSync, zip, type Zippable } from 'fflate';
import { formatJson, jsonError } from './json';
import { jsonErrorAt } from './json-locate';
import { downloadBlob, el, formatBytes, sniff, throwIfAborted, UserError } from './tool';

type Tool = 'json' | 'js' | 'zip' | 'gzip';
type Lang = 'json' | 'js' | 'text' | 'binary';
type Kind = 'info' | 'ok' | 'warn' | 'error';
type Sniffed = 'jpeg' | 'png' | 'webp' | 'pdf' | 'gzip' | 'zip' | 'unknown';

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
}

const MB = 1024 * 1024;
const MAX_TEXT = 50 * MB;
const WARN_TEXT = 5 * MB;
const MAX_JS = 10 * MB;
const MAX_ZIP = 500 * MB;
const MAX_GZ_IN = 200 * MB;
const MAX_GZ_OUT = 500 * MB;
const MAX_INLINE = 5 * MB;
const LINE = 20; // px; matches --fx-line
const TOOLS: Tool[] = ['json', 'js', 'zip', 'gzip'];
const INDENTS: Record<string, string> = { '2': '  ', '4': '    ', tab: '\t' };
const LANG_LABEL: Record<Lang, string> = { json: 'JSON', js: 'JavaScript', text: 'Plain text', binary: 'Binary' };
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

const lang = (it: Item): Lang => {
  if (it.text === undefined) return 'binary';
  if (/\.json$/i.test(it.name)) return 'json';
  if (/\.[cm]?js$/i.test(it.name)) return 'js';
  // Untitled documents (no extension) that look like JSON.
  return !/\.[^./]+$/.test(it.name) && /^\s*[[{]/.test(it.text.slice(0, 256)) ? 'json' : 'text';
};

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
  const cancelBtn = $<HTMLButtonElement>('[data-cancel]');
  const sbJson = $<HTMLButtonElement>('[data-sb-json]');
  const icons = $<HTMLTemplateElement>('[data-icons]');
  const icon = (name: string) => icons.content.querySelector(`[data-i="${name}"]`)!.firstElementChild!.cloneNode(true);
  const field = <T extends HTMLInputElement>(name: string) => root.querySelector<T>(`[name="${name}"]`)!;
  const checkedValue = (name: string) => root.querySelector<HTMLInputElement>(`[name="${name}"]:checked`)!.value;
  const narrow = matchMedia('(max-width: 760px)');

  let items: Item[] = [];
  let open: number[] = [];
  let active: number | undefined;
  const ticked = new Set<number>();
  let anchor: number | undefined;
  let roving: number | undefined;
  let nextId = 1;
  let untitled = 0;
  let shown: number | undefined; // item currently loaded in the textarea
  let dirty = false; // textarea differs from that item's text
  let lineCount = 1;
  let escaped = false;
  let busy: AbortController | null = null;
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

  // ---- Messages: status bar line + Output panel ----
  const say = (text: string, kind: Kind = 'info') => {
    msg.textContent = text;
    msg.dataset.kind = kind;
  };
  const setOutOpen = (open: boolean) => {
    outToggle.ariaExpanded = String(open);
    out.hidden = !open;
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
    $('[data-sb-enc]').textContent = text ? 'UTF-8' : '';
    $('[data-sb-lang]').textContent = it ? LANG_LABEL[lang(it)] : '';
    if (!text) $('[data-sb-pos]').textContent = '';
    const showJson = text && (lang(it) === 'json' || tool === 'json') && it.text!.trim() !== '';
    sbJson.hidden = !showJson;
    if (showJson) {
      const state = it.json ? (it.json.ok ? 'valid' : 'invalid') : 'unknown';
      sbJson.dataset.state = state;
      sbJson.replaceChildren(icon(state === 'invalid' ? 'warning' : 'check'), state === 'valid' ? 'Valid JSON' : state === 'invalid' ? 'Invalid JSON' : 'Check JSON');
      sbJson.title = it.json?.message ?? 'Validate JSON';
    }
  }

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
    empty.hidden = !!it;
    code.hidden = it?.text === undefined;
    hex.hidden = !it || it.text !== undefined;
    $('#fx-editor').setAttribute('aria-labelledby', it ? `fx-tab-${it.id}` : '');
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
        if (it.sniffed === 'gzip') rows.push(['Tip', 'Choose Gzip, then Decompress, to unpack it.']);
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
    renderTabs();
    renderExplorer();
    renderTools();
    analyse();
  }

  function openItem(id: number, focus = false) {
    if (active !== id) saveView();
    if (!open.includes(id)) open.push(id);
    active = id;
    showActive();
    if (narrow.matches) setExplorer(false);
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
    return { zip: 'files', gzip: 'files', jpeg: 'images', png: 'images', webp: 'images', pdf: 'pdf', unknown: 'doc' }[it.sniffed];
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
        row.dataset.kind = lang(it);
        if (it.id === active) row.dataset.active = '';
        const cb = el('input', { type: 'checkbox', checked: ticked.has(it.id), ariaLabel: `Select ${it.name}` });
        cb.onchange = () => tick(it.id, cb.checked);
        const openBtn = el('button', { type: 'button', className: 'fx-open', title: it.name }, icon(kindIcon(it)), el('span', { className: 'fx-name', textContent: it.name }), el('span', { className: 'fx-size', textContent: formatBytes(it.size) }));
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
    $('[data-count]').textContent = items.length ? `${items.length} file${items.length === 1 ? '' : 's'}${ticked.size ? ` · ${ticked.size} ticked` : ''}` : '';
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
        const it = byId(id)!;
        const x = el('span', { className: 'fx-tab-x', title: 'Close' }, icon('xmark'));
        x.dataset.x = '';
        x.ariaHidden = 'true';
        const tab = el('button', { type: 'button', className: 'fx-tab', id: `fx-tab-${id}`, tabIndex: id === active ? 0 : -1 }, icon(kindIcon(it)), el('span', { className: 'fx-tab-name', textContent: it.name }), x);
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
  function setTool(t: Tool) {
    tool = t;
    field(`tool"][value="${t}`).checked = true;
    $$('[data-panel]').forEach((p) => (p.hidden = p.dataset.panel !== t));
    renderTools();
    analyse();
  }

  function renderTools() {
    const it = cur();
    const isText = it?.text !== undefined;
    const set = (act: string, enabled: boolean) => ($<HTMLButtonElement>(`[data-act="${act}"]`).disabled = !!busy || !enabled);
    ['validate', 'minify-json', 'format', 'minify-js'].forEach((a) => set(a, isText));
    set('zip', items.length > 0);
    set('gzip', !!it);
    set('gunzip', it?.sniffed === 'gzip');
    $('[data-zip-scope]').textContent = !items.length ? 'Add files to archive' : ticked.size ? `${ticked.size} ticked file${ticked.size === 1 ? '' : 's'}` : `All ${items.length} file${items.length === 1 ? '' : 's'}`;
    $('[data-gzip-target]').textContent = it ? `${it.name} · ${formatBytes(it.size)}` : 'Open a file to compress or decompress';
    $('[data-act="gunzip"]').classList.toggle('fx-primary', it?.sniffed === 'gzip');
    $('[data-act="gzip"]').classList.toggle('fx-primary', !!it && it.sniffed !== 'gzip');
  }

  function startBusy(text: string, cancellable: boolean) {
    busy = new AbortController();
    say(text);
    progress.hidden = false;
    progress.removeAttribute('value');
    cancelBtn.hidden = !cancellable;
    renderTools();
    return busy.signal;
  }
  function endBusy() {
    busy = null;
    progress.hidden = true;
    cancelBtn.hidden = true;
    renderTools();
  }
  cancelBtn.onclick = () => busy?.abort();

  function fail(err: unknown) {
    if (err instanceof DOMException && err.name === 'AbortError') return say('Cancelled.');
    if (!(err instanceof UserError)) console.error(err);
    log('error', err instanceof UserError ? err.message : `Something went wrong: ${(err as Error).message ?? err}`);
  }

  function addOutput(name: string, data: { text?: string; blob?: Blob }, sniffed: Item['sniffed'] = 'unknown', note?: string) {
    const size = data.blob?.size ?? new Blob([data.text ?? '']).size;
    const it = addItem({ name: uniqueName(name), ...data, size, sniffed, generated: true, note });
    openItem(it.id);
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
      startBusy('Checking JSON…', false);
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
      startBusy('Minifying…', false);
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

  async function runZip() {
    if (busy) return;
    sync();
    const list = items.filter((it) => !ticked.size || ticked.has(it.id));
    try {
      if (!list.length) throw new UserError('Add files to archive first.');
      const blobs = list.map(blobOf);
      const total = blobs.reduce((s, b) => s + b.size, 0);
      if (total > MAX_ZIP) throw new UserError(`The selected files add up to ${formatBytes(total)}; the ZIP limit is ${formatBytes(MAX_ZIP)}.`);
      const level = Number(checkedValue('level')) as 0 | 6 | 9;
      const name = (field('zipName').value.trim().replace(/[\\/]+/g, '-') || 'archive').replace(/\.zip$/i, '') + '.zip';
      const signal = startBusy('Reading files…', true);
      // Deduplicate names so files with the same name don't overwrite each other.
      const entries: Zippable = {};
      for (const [i, it] of list.entries()) {
        throwIfAborted(signal);
        progress.value = i / list.length;
        let entry = it.name;
        for (let n = 2; entry in entries; n++) entry = it.name.replace(/(\.[^.]*)?$/, ` (${n})$1`);
        entries[entry] = [new Uint8Array(await blobs[i].arrayBuffer()), { level, mtime: it.mtime }];
      }
      say('Compressing…');
      progress.removeAttribute('value');
      const { promise, resolve, reject } = Promise.withResolvers<Uint8Array>();
      // Async fflate runs in workers and keeps the page responsive.
      const terminate = zip(entries, (err, data) => (err ? reject(err) : resolve(data)));
      signal.addEventListener('abort', () => {
        terminate();
        reject(new DOMException('Cancelled', 'AbortError'));
      });
      const data = await promise;
      const o = addOutput(name, { blob: new Blob([data as BlobPart], { type: 'application/zip' }) }, 'zip');
      log('ok', `Created ${o.name} from ${list.length} file${list.length === 1 ? '' : 's'}: ${formatBytes(total)} → ${formatBytes(o.size)}.`);
    } catch (err) {
      fail(err);
    } finally {
      if (busy) endBusy();
    }
  }

  async function runGzip(compress: boolean) {
    if (busy) return;
    sync();
    const it = cur();
    try {
      if (!it) throw new UserError('Open a file first.');
      const src = blobOf(it);
      if (src.size > MAX_GZ_IN) throw new UserError(`${it.name} is larger than ${formatBytes(MAX_GZ_IN)}, the gzip limit.`);
      if (!compress && (await sniff(src)) !== 'gzip') throw new UserError(`${it.name} is not gzip-compressed. Choose Compress instead.`);
      const signal = startBusy(compress ? 'Compressing…' : 'Decompressing…', true);
      const chunks: Uint8Array[] = [];
      let outSize = 0;
      const ondata = (chunk: Uint8Array) => {
        outSize += chunk.length;
        if (outSize > MAX_GZ_OUT) throw new UserError(`Decompressed data is larger than ${formatBytes(MAX_GZ_OUT)}; stopped to protect your device.`);
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
          progress.value = src.size ? read / src.size : 1;
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
      const text = compress ? null : await decodeText(blob, MAX_INLINE - 1);
      const o = text !== null ? addOutput(name, { text, blob }) : addOutput(name, { blob }, await sniff(blob));
      log('ok', `${compress ? 'Compressed' : 'Decompressed'} ${it.name} → ${o.name}: ${formatBytes(src.size)} → ${formatBytes(o.size)}.`);
    } catch (err) {
      fail(err);
    } finally {
      if (busy) endBusy();
    }
  }

  // ---- Files in: picker, hub hand-over, drop, paste ----
  async function addFiles(files: File[]) {
    let first: Item | undefined;
    for (const f of files) {
      const sniffed = await sniff(f);
      const text = await decodeText(f, MAX_TEXT);
      let note: string | undefined;
      if (text === null && sniffed === 'unknown' && f.size > MAX_TEXT) note = `Larger than ${formatBytes(MAX_TEXT)}, so it is not opened as text.`;
      else if (text === null && sniffed === 'unknown') note = 'Not UTF-8 text, so it is shown as binary.';
      const it = addItem({ name: f.name, text: text ?? undefined, blob: f, size: f.size, sniffed, generated: false, mtime: f.lastModified, note });
      if (text !== null && f.size > WARN_TEXT) log('warn', `${f.name} is ${formatBytes(f.size)}: the editor may be slow.`);
      first ??= it;
    }
    if (first) {
      openItem(first.id);
      say(`Added ${files.length} file${files.length === 1 ? '' : 's'}.`);
    }
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

  function setExplorer(show: boolean) {
    explorer.hidden = !show;
    explorerToggle.ariaExpanded = String(show);
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
    zip: runZip,
    gzip: () => runGzip(true),
    gunzip: () => runGzip(false),
  };
  $$('[data-act]').forEach((b) => b.addEventListener('click', () => acts[b.dataset.act!]()));

  ta.addEventListener('input', () => {
    dirty = true;
    const it = byId(shown)!;
    it.edited = true;
    analyse(it.size > WARN_TEXT ? 600 : 150);
    paint();
  });
  ta.addEventListener('scroll', paint);
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

  const mode = new URLSearchParams(location.search).get('mode') as Tool | null;
  setTool(mode && TOOLS.includes(mode) ? mode : 'json');
  if (narrow.matches) setExplorer(false);
  showActive();
}
