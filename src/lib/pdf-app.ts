// PDF app (src/pages/pdf/index.astro): one workspace for organize, merge, split, images to PDF and optimize.
// Every loaded PDF keeps its own page list (order, rotation, deletions); all outputs are built from those lists.
// pdf-lib (~500 KB), pdf.js and qpdf (wasm) are imported dynamically on first use to keep first paint instant.
import { zipSync } from 'fflate';
import type { PDFDocument } from '@cantoo/pdf-lib';
import type * as PdfJs from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFWorker } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import qpdfWasmUrl from '@neslinesli93/qpdf-wasm/dist/qpdf.wasm?url';
import { downloadBlob, el, formatBytes, setDial, sniff, throwIfAborted, tick, UserError, type Result } from './tool';
import { loadPdf, parseRanges, pdfBlob, SIGNATURE_NOTE } from './pdf';

type Mode = 'organize' | 'merge' | 'split' | 'from-images' | 'compress';
const MODES: Mode[] = ['organize', 'merge', 'split', 'from-images', 'compress'];
const MB = 1024 * 1024;
const MAX_TOTAL = 200 * MB;
const MAX_ONE = 100 * MB;
const MAX_PAGES = 500;
const MAX_IMAGES = 100;
const THUMB_PX = 128;
/** CSS px per PDF point at 100 % (96 dpi screen, 72 pt per inch). */
const PT = 96 / 72;
const ZOOMS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
/** Canvas backing-store cap per page (~64 MB of RGBA). */
const MAX_CANVAS_PX = 16e6;
const PAD = 22;
// PDF points (1/72 in), as in src/pages/pdf/from-images.astro.
const SIZES = { a4: [595.28, 841.89], letter: [612, 792] } as const;

interface Doc {
  file: File;
  lib: PDFDocument;
  signed: boolean;
  proxy?: PDFDocumentProxy;
  pages: Page[];
  group: HTMLElement;
  list: HTMLOListElement;
  toggle: HTMLButtonElement;
  count: HTMLElement;
  up: HTMLButtonElement;
  down: HTMLButtonElement;
}
interface Page {
  doc: Doc;
  index: number;
  /** CropBox size in points, unrotated. */
  w: number;
  h: number;
  /** /Rotate from the file. */
  base: number;
  /** User rotation on top of `base`. */
  rot: number;
  deleted: boolean;
  thumb: HTMLLIElement;
  art: HTMLElement;
  label: HTMLElement;
  thumbQueued: boolean;
  view: HTMLElement;
  /** Scale/rotation the view canvas was rendered for. */
  key: string;
}
interface Img {
  file: File;
  url: string;
  jpeg: boolean;
  /** Stored pixel size (what pdf-lib embeds; EXIF orientation is not applied). */
  w: number;
  h: number;
  thumb: HTMLLIElement;
  label: HTMLElement;
  view: HTMLElement;
  pic: HTMLImageElement;
}
type Item = Page | Img;
const isPage = (i: Item): i is Page => 'doc' in i;
interface ImgOptions {
  size: 'a4' | 'letter' | 'fit';
  orientation: string;
  margin: number;
}

export function initPdfApp(): void {
  const root = document.querySelector<HTMLElement>('[data-pdf-app]')!;
  const $ = <T extends Element = HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  const input = $<HTMLInputElement>('[data-input]');
  const docsBox = $('[data-docs]');
  const imgList = $<HTMLOListElement>('[data-images]');
  const side = $('[data-side]');
  const view = $('[data-view]');
  const pagesBox = $('[data-pages]');
  const runBtn = $<HTMLButtonElement>('[data-run]');
  const runLabel = $('[data-run-label]');
  const dlBtn = $<HTMLButtonElement>('[data-download]');
  const closeAll = $<HTMLButtonElement>('[data-close-all]');
  const zoomSel = $<HTMLSelectElement>('[data-zoom]');
  const pageInput = $<HTMLInputElement>('[data-page]');
  const pageCount = $('[data-page-count]');
  const msg = $('[data-msg]');
  const msgText = $('[data-msg-text]');
  const busy = $('[data-busy]');
  const dial = $('[data-dial]');
  const busyText = $('[data-busy-text]');
  const busyCancel = $<HTMLButtonElement>('[data-busy-cancel]');
  const resultsBox = $('[data-results]');
  const resultsTitle = $('[data-results-title]');
  const resultList = $<HTMLUListElement>('[data-result-list]');
  const splitForm = $<HTMLFormElement>('[data-split-form]');
  const imgForm = $<HTMLFormElement>('[data-img-form]');
  const rangesField = $('[data-ranges-field]');
  const rangesInput = splitForm.elements.namedItem('ranges') as HTMLInputElement;
  const useSel = $<HTMLButtonElement>('[data-use-selection]');
  const splitInfo = $('[data-split-info]');
  const sigBox = $('[data-sig]');
  const docLine = $('[data-doc-line]');
  const selInfo = $('[data-sel-info]');
  const announce = $('[data-announce]');
  const icons = $<HTMLTemplateElement>('[data-icons]').content;
  const icon = (name: string) => icons.querySelector(`.i-${name}`)!.cloneNode(true);

  let docs: Doc[] = [];
  let images: Img[] = [];
  let mode: Mode = 'organize';
  /** Set by ?mode= or a click on the mode switcher; stops automatic mode choice. */
  let pinned = false;
  let current: Item | undefined;
  let selected = new Set<Item>();
  let anchor: Item | undefined;
  let zoom: 'width' | 'page' | number = 'width';
  let scale = 1;
  let results: Result[] = [];
  let urls: string[] = [];
  let controller: AbortController | undefined;
  let dragged: Item | undefined;
  let pdfjs: typeof PdfJs | undefined;
  let worker: PDFWorker | undefined;

  const say = (text: string) => (announce.textContent = text);
  const pdfMode = () => mode !== 'from-images';
  /** Items shown in the sidebar and the view for the current mode, in output order. */
  const items = (): Item[] => (pdfMode() ? docs.flatMap((d) => d.pages) : images);
  const listOf = (i: Item): Item[] => (isPage(i) ? i.doc.pages : images);
  const activeDoc = (): Doc | undefined => (current && isPage(current) ? current.doc : docs[0]);
  const kept = (d: Doc) => d.pages.filter((p) => !p.deleted);

  function notify(text: string, kind: 'info' | 'error' = 'info') {
    msg.dataset.kind = kind;
    msgText.textContent = text;
    msg.hidden = !text;
  }
  const errorText = (err: unknown) => (err instanceof UserError ? err.message : `Something went wrong: ${(err as Error)?.message ?? err}`);

  // ---------- Loading ----------
  async function getPdfjs() {
    if (!pdfjs) {
      pdfjs = await import('pdfjs-dist');
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
      // One worker for all documents; destroying a document leaves it running.
      worker = new pdfjs.PDFWorker();
    }
    return pdfjs;
  }

  async function openPdf(file: File): Promise<Doc> {
    const loaded = await loadPdf(file);
    const n = loaded.doc.getPageCount();
    if (!n) throw new UserError(`“${file.name}” has no pages.`);
    const doc = createDoc(file, loaded.doc, loaded.hasSignature);
    doc.pages = loaded.doc.getPages().map((pg, index) => {
      let box: { width: number; height: number };
      try {
        box = pg.getCropBox();
      } catch {
        box = pg.getSize();
      }
      return createPage(doc, index, Math.abs(box.width) || 612, Math.abs(box.height) || 792, ((pg.getRotation().angle % 360) + 360) % 360);
    });
    return doc;
  }

  /** Previews are best-effort: pdf.js may fail on files pdf-lib can still process. */
  async function attachPreview(doc: Doc) {
    try {
      const lib = await getPdfjs();
      const proxy = await lib.getDocument({ data: new Uint8Array(await doc.file.arrayBuffer()), worker }).promise;
      if (!docs.includes(doc)) return void proxy.loadingTask.destroy();
      doc.proxy = proxy;
      for (const p of doc.pages) {
        if (visible.has(p)) want(p);
        if (thumbsSeen.has(p)) queueThumb(p);
      }
    } catch {
      for (const p of doc.pages) {
        p.art.firstElementChild?.setAttribute('data-failed', '');
        p.view.dataset.failed = '';
      }
    }
  }

  /** `keepMode`: results opened from the results strip stay in the current PDF mode. */
  async function addFiles(files: File[], keepMode = false) {
    if (!files.length || controller) return;
    const errors: string[] = [];
    let addedPdf = false;
    let addedImg = false;
    let first: Item | undefined;
    showBusy('Opening…');
    try {
      for (const f of files) {
        busyText.textContent = `Opening ${f.name}…`;
        await tick();
        const kind = await sniff(f);
        try {
          if (kind === 'pdf') {
            const total = docs.reduce((s, d) => s + d.file.size, 0) + f.size;
            if (total > MAX_TOTAL) throw new UserError(`“${f.name}” would bring the PDFs over 200 MB in total.`);
            const doc = await openPdf(f);
            docs.push(doc);
            void attachPreview(doc);
            first ??= doc.pages[0];
            addedPdf = true;
          } else if (kind === 'jpeg' || kind === 'png') {
            if (images.length >= MAX_IMAGES) throw new UserError(`“${f.name}” not added: up to ${MAX_IMAGES} images per PDF.`);
            const img = await openImage(f, kind === 'jpeg');
            images.push(img);
            first ??= img;
            addedImg = true;
          } else throw new UserError(`“${f.name}” is not a PDF, JPEG or PNG.`);
        } catch (err) {
          errors.push(errorText(err));
        }
      }
    } finally {
      busy.hidden = true;
    }
    if (addedPdf || addedImg) {
      if ((!pinned && !(keepMode && pdfMode())) || (mode === 'from-images' ? !images.length : !docs.length)) setMode(addedPdf ? (docs.length > 1 ? 'merge' : 'organize') : 'from-images', false);
      changed();
      if (first && items().includes(first)) select(first, 'only', true);
    }
    notify(errors.join('\n'), 'error');
  }

  async function openImage(file: File, jpeg: boolean): Promise<Img> {
    const { w, h } = await pixelSize(file, jpeg);
    const url = URL.createObjectURL(file);
    const pic = el('img', { src: url, alt: '' });
    const thumbImg = el('img', { src: url, alt: '' });
    const label = el('span', { className: 'pa-thumb-label', textContent: file.name });
    const thumb = el('li', { className: 'pa-thumb', role: 'option', tabIndex: -1, draggable: true, title: file.name }, el('span', { className: 'pa-thumb-box' }, el('span', { className: 'pa-art' }, thumbImg)), label);
    const img: Img = { file, url, jpeg, w, h, thumb, label, view: el('div', { className: 'pa-page' }, pic), pic };
    wireItem(img);
    return img;
  }

  /** Stored pixel size from the file header, ignoring EXIF orientation, so the preview matches what pdf-lib embeds. */
  async function pixelSize(file: File, jpeg: boolean): Promise<{ w: number; h: number }> {
    const bad = () => new UserError(`“${file.name}” could not be read. It may be damaged or use an unsupported variant.`);
    if (!jpeg) {
      const v = new DataView(await file.slice(16, 24).arrayBuffer());
      if (v.byteLength < 8) throw bad();
      return { w: v.getUint32(0), h: v.getUint32(4) };
    }
    const b = new Uint8Array(await file.slice(0, Math.min(file.size, 1024 * 1024)).arrayBuffer());
    for (let i = 2; i + 9 < b.length; ) {
      if (b[i] !== 0xff) throw bad();
      const m = b[i + 1];
      // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC).
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8] };
      i += 2 + ((b[i + 2] << 8) | b[i + 3]);
    }
    throw bad();
  }

  function createDoc(file: File, lib: PDFDocument, signed: boolean): Doc {
    const btn = (label: string, name: string) => {
      const b = el('button', { type: 'button', className: 'pa-tool', ariaLabel: `${label}: ${file.name}`, title: label });
      b.append(icon(name));
      return b;
    };
    const toggle = el('button', { type: 'button', className: 'pa-doc-toggle', title: file.name });
    const count = el('span', { className: 'pa-doc-count' });
    toggle.append(icon('chevron'), el('span', { className: 'pa-doc-name', textContent: file.name }), count);
    toggle.setAttribute('aria-expanded', 'true');
    const up = btn('Move document up', 'up');
    const down = btn('Move document down', 'down');
    const remove = btn('Close document', 'close');
    const list = el('ol', { className: 'pa-list', role: 'listbox', ariaLabel: `Pages of ${file.name}` });
    list.setAttribute('aria-multiselectable', 'true');
    const group = el('section', { className: 'pa-doc' }, el('div', { className: 'pa-doc-head' }, toggle, up, down, remove), list);
    const doc: Doc = { file, lib, signed, pages: [], group, list, toggle, count, up, down };
    toggle.addEventListener('click', () => {
      const open = list.hidden;
      list.hidden = !open;
      toggle.setAttribute('aria-expanded', String(open));
    });
    const moveDoc = (by: number, btn: HTMLButtonElement) => {
      const i = docs.indexOf(doc);
      const to = i + by;
      if (to < 0 || to >= docs.length) return;
      docs.splice(i, 1);
      docs.splice(to, 0, doc);
      changed();
      (btn.disabled ? (btn === up ? down : up) : btn).focus();
      say(`${file.name} moved to position ${to + 1} of ${docs.length}.`);
    };
    up.addEventListener('click', () => moveDoc(-1, up));
    down.addEventListener('click', () => moveDoc(1, down));
    remove.addEventListener('click', () => {
      closeDoc(doc);
      changed();
      say(`${file.name} closed.`);
    });
    return doc;
  }

  function createPage(doc: Doc, index: number, w: number, h: number, base: number): Page {
    const paper = el('span', { className: 'pa-paper' });
    const art = el('span', { className: 'pa-art' }, paper);
    const label = el('span', { className: 'pa-thumb-label' });
    const thumb = el('li', { className: 'pa-thumb', role: 'option', tabIndex: -1, draggable: true }, el('span', { className: 'pa-thumb-box' }, art), label);
    const view = el('div', { className: 'pa-page', role: 'img' });
    const page: Page = { doc, index, w, h, base, rot: 0, deleted: false, thumb, art, label, thumbQueued: false, view, key: '' };
    // Placeholder sheet with the page's shape until the thumbnail renders.
    const [tw, th] = base % 180 ? [h, w] : [w, h];
    paper.style.aspectRatio = `${tw} / ${th}`;
    paper.style[tw >= th ? 'width' : 'height'] = '100%';
    wireItem(page);
    return page;
  }

  function closeDoc(doc: Doc) {
    void doc.proxy?.loadingTask.destroy();
    doc.proxy = undefined;
    for (const p of doc.pages) {
      visible.delete(p);
      thumbsSeen.delete(p);
      selected.delete(p);
    }
    docs = docs.filter((d) => d !== doc);
    doc.group.remove();
  }

  function removeImages(list: Img[]) {
    for (const img of list) {
      URL.revokeObjectURL(img.url);
      selected.delete(img);
      img.thumb.remove();
      img.view.remove();
    }
    images = images.filter((i) => !list.includes(i));
  }

  // ---------- Sidebar items: selection, keyboard, drag ----------
  function wireItem(item: Item) {
    const { thumb } = item;
    thumb.addEventListener('click', (e) => {
      if (e.shiftKey) select(item, 'range');
      else if (e.ctrlKey || e.metaKey) select(item, 'toggle');
      else select(item, 'only', true);
    });
    thumb.addEventListener('keydown', (e) => onItemKey(e, item));
    // Drag-and-drop is an enhancement; Alt+arrows and the Move buttons are the accessible path.
    thumb.addEventListener('dragstart', (e) => {
      dragged = item;
      e.dataTransfer?.setData('text/plain', '');
      thumb.classList.add('dragging');
    });
    thumb.addEventListener('dragend', () => {
      dragged = undefined;
      thumb.classList.remove('dragging');
      for (const t of side.querySelectorAll('.drop-before, .drop-after')) t.classList.remove('drop-before', 'drop-after');
    });
    const after = (e: DragEvent) => e.offsetY > thumb.offsetHeight / 2;
    thumb.addEventListener('dragover', (e) => {
      if (!dragged || dragged === item || listOf(dragged) !== listOf(item)) return;
      e.preventDefault();
      thumb.classList.toggle('drop-after', after(e));
      thumb.classList.toggle('drop-before', !after(e));
    });
    thumb.addEventListener('dragleave', () => thumb.classList.remove('drop-before', 'drop-after'));
    thumb.addEventListener('drop', (e) => {
      if (!dragged || dragged === item || listOf(dragged) !== listOf(item)) return;
      e.preventDefault();
      e.stopPropagation();
      thumb.classList.remove('drop-before', 'drop-after');
      const list = listOf(item);
      const moving = dragged;
      list.splice(list.indexOf(moving), 1);
      list.splice(list.indexOf(item) + (after(e) ? 1 : 0), 0, moving);
      changed();
      select(moving, 'only', true);
      say(`Moved to position ${list.indexOf(moving) + 1} of ${list.length}.`);
    });
  }

  function onItemKey(e: KeyboardEvent, item: Item) {
    const all = items();
    const i = all.indexOf(item);
    const go = (to: number) => {
      const next = all[Math.max(0, Math.min(all.length - 1, to))];
      if (!next) return;
      if (e.shiftKey && listOf(next) === listOf(item)) select(next, 'range', true);
      else select(next, 'only', true);
    };
    const mod = e.ctrlKey || e.metaKey;
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) act(e.key === 'ArrowUp' ? 'up' : 'down');
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') go(i - 1);
    else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') go(i + 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(all.length - 1);
    else if (e.key === ' ') select(item, mod ? 'toggle' : 'only', true);
    else if (e.key === 'Enter') scrollToItem(item);
    else if (mod && e.key.toLowerCase() === 'a') act('select-all');
    else if (e.key === 'Delete' || e.key === 'Backspace') act('delete');
    else if (!mod && e.key.toLowerCase() === 'r' && isPage(item)) act(e.shiftKey ? 'rotate-left' : 'rotate-right');
    else return;
    e.preventDefault();
  }

  /** `only`: just this item; `toggle`: add/remove; `range`: anchor..item within one list. Selection never spans documents. */
  function select(item: Item, how: 'only' | 'toggle' | 'range', scroll = false) {
    const list = listOf(item);
    if (how !== 'only' && [...selected].some((s) => listOf(s) !== list)) how = 'only';
    if (how === 'only') {
      selected = new Set([item]);
      anchor = item;
    } else if (how === 'toggle') {
      if (selected.has(item) && selected.size > 1) selected.delete(item);
      else selected.add(item);
      anchor = item;
    } else {
      const a = anchor && listOf(anchor) === list ? list.indexOf(anchor) : list.indexOf(item);
      const b = list.indexOf(item);
      selected = new Set(list.slice(Math.min(a, b), Math.max(a, b) + 1));
    }
    setCurrent(item, true);
    paintSelection();
    if (scroll) scrollToItem(item);
  }

  function setCurrent(item: Item | undefined, focus = false) {
    const prev = current;
    current = item;
    for (const i of items()) {
      i.thumb.tabIndex = i === item ? 0 : -1;
      i.thumb.toggleAttribute('aria-current', i === item);
      if (i === item) i.thumb.setAttribute('aria-current', 'true');
    }
    if (focus && item && side.contains(document.activeElement)) item.thumb.focus();
    else item?.thumb.scrollIntoView({ block: 'nearest' });
    const n = item ? items().indexOf(item) + 1 : 0;
    if (document.activeElement !== pageInput) pageInput.value = String(n || '');
    if (prev !== item && (!prev || !item || !isPage(prev) || !isPage(item) || prev.doc !== item.doc)) panel();
  }

  function paintSelection() {
    for (const i of items()) {
      const on = selected.has(i);
      i.thumb.setAttribute('aria-selected', String(on));
      i.view.toggleAttribute('data-selected', on && selected.size > 1);
    }
    panel();
  }

  /** Selected items in list order, falling back to the current item. */
  function selection(): Item[] {
    const list = current ? listOf(current) : [];
    const sel = list.filter((i) => selected.has(i));
    return sel.length ? sel : current ? [current] : [];
  }

  function act(name: string) {
    // Re-inserted nodes lose focus; remember whether to put keyboard users back on the current item.
    const keepFocus = side.contains(document.activeElement);
    const sel = selection();
    if (!sel.length && name !== 'reverse' && name !== 'reset') return;
    const list = sel.length ? listOf(sel[0]) : pdfMode() ? (activeDoc()?.pages ?? []) : images;
    const pages = sel.filter(isPage);
    const n = sel.length === 1 ? (isPage(sel[0]) ? 'Page' : 'Image') : `${sel.length} ${isPage(sel[0]) ? 'pages' : 'images'}`;
    switch (name) {
      case 'rotate-left':
      case 'rotate-right':
        for (const p of pages) p.rot = (p.rot + (name === 'rotate-left' ? 270 : 90)) % 360;
        say(`${n} rotated ${name === 'rotate-left' ? 'left' : 'right'}.`);
        break;
      case 'up':
      case 'down': {
        const by = name === 'up' ? -1 : 1;
        const idx = sel.map((i) => list.indexOf(i));
        if (by < 0 ? idx[0] === 0 : idx[idx.length - 1] === list.length - 1) return;
        const order = by < 0 ? idx : [...idx].reverse();
        for (const i of order) [list[i], list[i + by]] = [list[i + by], list[i]];
        say(`${n} moved ${name}.`);
        break;
      }
      case 'delete':
        if (pages.length) {
          const restore = pages.every((p) => p.deleted);
          for (const p of pages) p.deleted = !restore;
          say(`${n} ${restore ? 'restored' : 'deleted'}.`);
        } else {
          const at = images.indexOf(sel[0] as Img);
          removeImages(sel as Img[]);
          say(`${n} removed.`);
          changed();
          const next = images[Math.min(at, images.length - 1)];
          if (next) select(next, 'only', true);
          if (keepFocus) next?.thumb.focus();
          return;
        }
        break;
      case 'select-all':
        selected = new Set(list);
        anchor = list[0];
        paintSelection();
        return;
      case 'reverse':
        list.reverse();
        say('Order reversed.');
        break;
      case 'reset': {
        const doc = activeDoc();
        if (!doc) return;
        doc.pages.sort((a, b) => a.index - b.index);
        for (const p of doc.pages) {
          p.rot = 0;
          p.deleted = false;
        }
        say('All changes to this document reset.');
        break;
      }
    }
    changed();
    if (keepFocus) current?.thumb.focus();
  }

  // ---------- Layout ----------
  /** Rebuild sidebar and view order, labels and sizes after any change to the documents or images. */
  function changed() {
    clearResults();
    const all = items();
    root.toggleAttribute('data-empty', !all.length);
    closeAll.disabled = !docs.length && !images.length;
    for (const c of root.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('[data-zoom-in], [data-zoom-out], [data-zoom], [data-page]')) c.disabled = !all.length;
    if (current && !all.includes(current)) current = undefined;
    if (!current && all.length) setCurrent(all[0]);
    if (!all.length) setCurrent(undefined);

    // Sidebar
    const groups = docs.map((d) => d.group);
    if (groups.some((g, i) => docsBox.children[i] !== g) || docsBox.children.length !== groups.length) docsBox.replaceChildren(...groups);
    docs.forEach((d, di) => {
      if (d.pages.some((p, i) => d.list.children[i] !== p.thumb)) d.list.replaceChildren(...d.pages.map((p) => p.thumb));
      const k = kept(d).length;
      d.count.textContent = `${k}${k < d.pages.length ? `/${d.pages.length}` : ''}`;
      d.up.hidden = d.down.hidden = docs.length < 2;
      d.up.disabled = di === 0;
      d.down.disabled = di === docs.length - 1;
      let n = 0;
      for (const p of d.pages) {
        const pos = p.deleted ? 0 : ++n;
        p.label.textContent = p.deleted ? 'Deleted' : String(pos);
        p.thumb.ariaLabel = `${p.deleted ? 'Deleted page' : `Page ${pos}`}${p.index + 1 !== pos ? ` (page ${p.index + 1} of the original)` : ''}${p.rot ? `, rotated ${p.rot}°` : ''}`;
        p.thumb.toggleAttribute('data-deleted', p.deleted);
        p.art.style.transform = p.rot ? `rotate(${p.rot}deg)` : '';
        p.view.toggleAttribute('data-deleted', p.deleted);
        p.view.ariaLabel = p.thumb.ariaLabel;
      }
    });
    if (images.some((img, i) => imgList.children[i] !== img.thumb) || imgList.children.length !== images.length) imgList.replaceChildren(...images.map((i) => i.thumb));
    images.forEach((img, i) => {
      img.thumb.ariaLabel = `Page ${i + 1}: ${img.file.name}`;
      img.view.ariaLabel = img.thumb.ariaLabel;
    });

    // View
    // Keep the current page where it is on screen while pages move around it.
    const before = current?.view.isConnected ? current.view.getBoundingClientRect().top : undefined;
    if (all.some((it, i) => pagesBox.children[i] !== it.view) || pagesBox.children.length !== all.length) pagesBox.replaceChildren(...all.map((i) => i.view));
    if (current && before !== undefined) view.scrollTop += current.view.getBoundingClientRect().top - before;
    pageCount.textContent = String(all.length);
    pageInput.max = String(Math.max(1, all.length));
    if (current) pageInput.value = String(all.indexOf(current) + 1);
    paintSelection();
    layout();
  }

  /** Displayed size in points, after rotation; for images, the page they become. */
  function dims(item: Item): { w: number; h: number } {
    if (isPage(item)) return (item.base + item.rot) % 180 ? { w: item.h, h: item.w } : { w: item.w, h: item.h };
    const g = imageLayout(item, imgOptions());
    return { w: g.pw, h: g.ph };
  }

  function fitScale(): number {
    const all = items();
    if (!all.length) return 1;
    const aw = view.clientWidth - 2 * PAD;
    const ah = view.clientHeight - 2 * PAD;
    if (zoom === 'width') return Math.max(0.1, aw / Math.max(...all.map((i) => dims(i).w)));
    const d = dims(current ?? all[0]);
    return Math.max(0.1, Math.min(aw / d.w, ah / d.h));
  }

  function layout() {
    // Keep the current page at the same spot while the zoom changes.
    const anchorEl = current?.view;
    const ratio = anchorEl && anchorEl.offsetHeight ? (view.scrollTop - anchorEl.offsetTop) / anchorEl.offsetHeight : 0;
    const old = scale;
    scale = typeof zoom === 'number' ? zoom * PT : fitScale();
    const opts = imgOptions();
    for (const it of items()) {
      const d = dims(it);
      it.view.style.width = `${Math.round(d.w * scale)}px`;
      it.view.style.height = `${Math.round(d.h * scale)}px`;
      if (!isPage(it)) {
        const g = imageLayout(it, opts);
        Object.assign(it.pic.style, { left: `${(g.x / g.pw) * 100}%`, top: `${((g.ph - g.y - g.h) / g.ph) * 100}%`, width: `${(g.w / g.pw) * 100}%`, height: `${(g.h / g.ph) * 100}%` });
      }
    }
    if (anchorEl && scale !== old) view.scrollTop = anchorEl.offsetTop + ratio * anchorEl.offsetHeight;
    for (const p of visible) want(p);
    const pct = Math.round((scale / PT) * 100);
    zoomSel.options[0].textContent = zoom === 'width' ? `Fit width (${pct}%)` : 'Fit width';
    zoomSel.options[1].textContent = zoom === 'page' ? `Fit page (${pct}%)` : 'Fit page';
    zoomSel.value = String(zoom);
  }

  function setZoom(z: typeof zoom) {
    zoom = z;
    layout();
  }
  function stepZoom(dir: 1 | -1) {
    const cur = scale / PT;
    const next = dir > 0 ? ZOOMS.find((z) => z > cur + 0.001) : [...ZOOMS].reverse().find((z) => z < cur - 0.001);
    if (next) setZoom(next);
  }

  function scrollToItem(item: Item) {
    const top = item.view.offsetTop - PAD;
    view.scrollTo({ top, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    scrollTarget = item;
  }

  // ---------- Rendering ----------
  const visible = new Set<Page>();
  const thumbsSeen = new Set<Page>();
  const viewQueue = new Set<Page>();
  const thumbQueue: Page[] = [];
  let rendering = 0;
  const pageOf = new WeakMap<Element, Item>();
  const keyOf = (p: Page) => `${scale.toFixed(4)}|${p.rot}`;

  const viewObserver = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const it = pageOf.get(e.target);
        if (!it || !isPage(it)) continue;
        if (e.isIntersecting) {
          visible.add(it);
          want(it);
        } else {
          // Far from view: free the canvas memory.
          visible.delete(it);
          viewQueue.delete(it);
          it.view.querySelector('canvas')?.remove();
          it.key = '';
        }
      }
    },
    { root: view, rootMargin: '75% 0px' },
  );
  const thumbObserver = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const it = pageOf.get(e.target);
        if (!it || !isPage(it) || !e.isIntersecting) continue;
        thumbsSeen.add(it);
        queueThumb(it);
      }
    },
    { root: side, rootMargin: '300px 0px' },
  );
  // Observe every page/thumb node once; nodes persist across reorders.
  new MutationObserver(() => {
    for (const d of docs)
      for (const p of d.pages)
        if (!pageOf.has(p.view)) {
          pageOf.set(p.view, p);
          pageOf.set(p.thumb, p);
          viewObserver.observe(p.view);
          thumbObserver.observe(p.thumb);
        }
  }).observe(pagesBox, { childList: true });

  function want(p: Page) {
    if (p.doc.proxy && p.key !== keyOf(p)) viewQueue.add(p);
    pump();
  }
  function queueThumb(p: Page) {
    if (p.doc.proxy && !p.thumbQueued) {
      p.thumbQueued = true;
      thumbQueue.push(p);
      pump();
    }
  }

  function pump() {
    while (rendering < 2 && (viewQueue.size || thumbQueue.length)) {
      let job: Promise<void>;
      if (viewQueue.size) {
        const p = viewQueue.values().next().value!;
        viewQueue.delete(p);
        job = renderView(p);
      } else job = renderThumb(thumbQueue.shift()!);
      rendering++;
      job.catch(() => {}).finally(() => {
        rendering--;
        pump();
      });
    }
  }

  async function renderView(p: Page) {
    const key = keyOf(p);
    const proxy = p.doc.proxy;
    if (!proxy || !visible.has(p) || p.key === key) return;
    const pg = await proxy.getPage(p.index + 1);
    let s = scale * Math.min(devicePixelRatio || 1, 3);
    const d = dims(p);
    if (d.w * d.h * s * s > MAX_CANVAS_PX) s = Math.sqrt(MAX_CANVAS_PX / (d.w * d.h));
    const viewport = pg.getViewport({ scale: s, rotation: (pg.rotate + p.rot) % 360 });
    const canvas = el('canvas', { width: Math.ceil(viewport.width), height: Math.ceil(viewport.height) });
    canvas.setAttribute('aria-hidden', 'true');
    await pg.render({ canvas, viewport }).promise;
    if (proxy !== p.doc.proxy || !visible.has(p) || keyOf(p) !== key) return;
    p.view.querySelector('canvas')?.remove();
    p.view.prepend(canvas);
    p.key = key;
  }

  async function renderThumb(p: Page) {
    const proxy = p.doc.proxy;
    if (!proxy || !docs.includes(p.doc)) return;
    const pg = await proxy.getPage(p.index + 1);
    const base = pg.getViewport({ scale: 1 });
    const viewport = pg.getViewport({ scale: (THUMB_PX * Math.min(devicePixelRatio || 1, 2)) / Math.max(base.width, base.height) });
    const canvas = el('canvas', { width: Math.ceil(viewport.width), height: Math.ceil(viewport.height) });
    canvas.setAttribute('aria-hidden', 'true');
    await pg.render({ canvas, viewport }).promise;
    pg.cleanup();
    if (proxy === p.doc.proxy) p.art.replaceChildren(canvas);
  }

  // Current page follows scrolling; a single selection follows along.
  let scrollTarget: Item | undefined;
  let scrollFrame = 0;
  view.addEventListener('scroll', () => {
    cancelAnimationFrame(scrollFrame);
    scrollFrame = requestAnimationFrame(() => {
      const all = items();
      const line = view.scrollTop + view.clientHeight * 0.35;
      const at = all.find((it) => it.view.offsetTop + it.view.offsetHeight + 9 > line) ?? all[all.length - 1];
      // While a smooth scroll to a clicked page runs, don't let pages passed on the way take over.
      if (scrollTarget && at !== scrollTarget) return;
      scrollTarget = undefined;
      if (!at || at === current) return;
      if (selected.size <= 1) {
        selected = new Set([at]);
        anchor = at;
      }
      setCurrent(at);
      paintSelection();
    });
  });
  view.addEventListener('scrollend', () => (scrollTarget = undefined));
  new ResizeObserver(() => typeof zoom !== 'number' && layout()).observe(view);

  view.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === '+' || e.key === '=') stepZoom(1);
    else if (e.key === '-') stepZoom(-1);
    else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && current && view.scrollWidth <= view.clientWidth) {
      const all = items();
      const next = all[all.indexOf(current) + (e.key === 'ArrowLeft' ? -1 : 1)];
      if (next) select(next, 'only', true);
    } else return;
    e.preventDefault();
  });

  // ---------- Mode & inspector ----------
  function setMode(next: Mode, pin: boolean) {
    if (pin) pinned = true;
    const switched = next !== mode;
    mode = next;
    root.dataset.mode = mode;
    const radio = root.querySelector<HTMLInputElement>(`input[name="pa-mode"][value="${mode}"]`)!;
    radio.checked = true;
    // The switcher scrolls sideways on narrow screens.
    radio.parentElement!.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    runLabel.textContent = radio.dataset.action!;
    $('[data-empty-title]').textContent = mode === 'from-images' ? 'Drop JPEG or PNG images, or choose files' : 'Drop PDFs or images, or choose files';
    if (pin) {
      const url = new URL(location.href);
      url.searchParams.set('mode', mode);
      history.replaceState(history.state, '', url);
    }
    if (switched) {
      selected.clear();
      current = undefined;
      changed();
      view.scrollTop = 0;
    }
  }

  function panel() {
    const doc = activeDoc();
    const all = items();
    runBtn.disabled = dlBtn.disabled = !all.length || !!controller;
    const single = mode === 'organize' || mode === 'split' || mode === 'compress';
    for (const d of docs) d.group.toggleAttribute('data-active', docs.length > 1 && d === doc);
    docLine.textContent = single && doc && docs.length > 1 ? doc.file.name : '';
    sigBox.hidden = !(mode === 'merge' ? docs.some((d) => d.signed) : single && doc?.signed);

    const sel = selection();
    const pages = sel.filter(isPage);
    const one = pages.length === 1 ? (pages[0].deleted ? 'Deleted page' : `Page ${kept(pages[0].doc).indexOf(pages[0]) + 1}`) : '';
    selInfo.textContent = pages.length ? (one ? `${one} selected. Shift or Ctrl/Cmd+click to select more.` : `${pages.length} pages selected.`) : '';
    const restoring = pages.length > 0 && pages.every((p) => p.deleted);
    $('[data-panel="organize"] [data-act="delete"] [data-label]').textContent = restoring ? 'Restore' : 'Delete';

    if (mode === 'merge') {
      const total = docs.reduce((s, d) => s + d.file.size, 0);
      const pageTotal = docs.reduce((s, d) => s + kept(d).length, 0);
      $('[data-merge-info]').textContent = docs.length ? `${docs.length} ${docs.length === 1 ? 'document' : 'documents'} · ${pageTotal} ${pageTotal === 1 ? 'page' : 'pages'} · ${formatBytes(total)}` : '';
    }
    if (mode === 'split') splitSummary();
    if (mode === 'from-images') $('[data-img-info]').textContent = images.length ? `${images.length} ${images.length === 1 ? 'image' : 'images'} · one page each, in sidebar order.` : '';
    if (mode === 'compress') {
      const box = $('[data-compress-info]');
      box.replaceChildren();
      if (doc) box.append(el('dt', { textContent: 'Before' }), el('dd', { textContent: formatBytes(doc.file.size) }));
      const r = results.find((r) => r.inputSize);
      if (r) box.append(el('dt', { textContent: 'After' }), el('dd', { textContent: r.blob === doc?.file ? `${formatBytes(r.blob.size)} (unchanged)` : formatBytes(r.blob.size) }));
    }
  }

  function splitSummary() {
    const how = new FormData(splitForm).get('split');
    rangesField.hidden = useSel.hidden = how === 'each';
    const doc = activeDoc();
    if (!doc) return void (splitInfo.textContent = '');
    const n = kept(doc).length;
    if (how === 'each') return void (splitInfo.textContent = `${n} PDFs, one per page, plus a ZIP of all.`);
    try {
      const groups = parseRanges(rangesInput.value, n);
      splitInfo.textContent =
        how === 'extract'
          ? `1 PDF with ${groups.flat().length} ${groups.flat().length === 1 ? 'page' : 'pages'}, in the order listed.`
          : `${groups.length} ${groups.length === 1 ? 'PDF' : 'PDFs'}, one per range${groups.length > 1 ? ', plus a ZIP of all' : ''}.`;
    } catch (err) {
      splitInfo.textContent = rangesInput.value.trim() ? errorText(err) : `Page numbers 1–${n}. Each range becomes its own PDF${how === 'extract' ? '; Extract combines them into one' : ''}.`;
    }
  }

  /** Selected pages (current doc) as a compact range list, e.g. "1-3, 5". */
  function selectionRanges(): string {
    const doc = activeDoc();
    if (!doc) return '';
    const k = kept(doc);
    const nums = selection().filter((i): i is Page => isPage(i) && !i.deleted).map((p) => k.indexOf(p) + 1).sort((a, b) => a - b);
    const out: string[] = [];
    for (let i = 0; i < nums.length; ) {
      let j = i;
      while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
      out.push(i === j ? `${nums[i]}` : `${nums[i]}-${nums[j]}`);
      i = j + 1;
    }
    return out.join(', ');
  }

  function imgOptions(): ImgOptions {
    const d = new FormData(imgForm);
    return { size: String(d.get('size')) as ImgOptions['size'], orientation: String(d.get('orientation')), margin: Number(d.get('margin')) };
  }

  /** Page geometry for one image, shared by the preview and the PDF output (same maths as the standalone tool). */
  function imageLayout(img: { w: number; h: number }, o: ImgOptions) {
    const landscape = o.orientation === 'landscape' || (o.orientation === 'auto' && img.w > img.h);
    let [pw, ph]: number[] = o.size === 'fit' ? [img.w + 2 * o.margin, img.h + 2 * o.margin] : [...SIZES[o.size]];
    if (o.size !== 'fit' && landscape) [pw, ph] = [ph, pw];
    const s = Math.min((pw - 2 * o.margin) / img.w, (ph - 2 * o.margin) / img.h);
    const w = img.w * s;
    const h = img.h * s;
    return { pw, ph, x: (pw - w) / 2, y: (ph - h) / 2, w, h };
  }

  // ---------- Output ----------
  type Progress = (text: string, fraction?: number) => void;

  /** Copy pages (any documents, in order) into a new PDF with the user's rotations. */
  async function build(pages: Page[], signal: AbortSignal, progress?: Progress): Promise<Uint8Array> {
    const { PDFDocument, degrees } = await import('@cantoo/pdf-lib');
    const out = await PDFDocument.create();
    // Copy runs from the same document together so shared resources (fonts, images) are copied once per run.
    for (let i = 0; i < pages.length; ) {
      throwIfAborted(signal);
      let j = i;
      while (j + 1 < pages.length && pages[j + 1].doc === pages[i].doc) j++;
      const run = pages.slice(i, j + 1);
      progress?.(`Copying pages from ${run[0].doc.file.name}`, i / pages.length);
      await tick();
      const copied = await out.copyPages(run[0].doc.lib, run.map((p) => p.index));
      run.forEach((p, k) => {
        const pg = copied[k];
        if (p.rot) pg.setRotation(degrees((pg.getRotation().angle + p.rot) % 360));
        out.addPage(pg);
      });
      i = j + 1;
    }
    throwIfAborted(signal);
    progress?.('Saving…');
    await tick();
    return out.save({ useObjectStreams: true });
  }

  const baseName = (name: string) => name.replace(/\.pdf$/i, '');
  const needDoc = () => {
    const doc = activeDoc();
    if (!doc) throw new UserError('Open a PDF first.');
    return doc;
  };
  const needKept = (doc: Doc) => {
    const k = kept(doc);
    if (!k.length) throw new UserError('All pages are deleted. Restore at least one page.');
    return k;
  };

  const runners: Record<Mode, (signal: AbortSignal, progress: Progress) => Promise<Result[]>> = {
    async organize(signal, progress) {
      const doc = needDoc();
      if (doc.file.size > MAX_ONE) throw new UserError('This PDF is larger than 100 MB.');
      if (doc.pages.length > MAX_PAGES) throw new UserError(`This PDF has ${doc.pages.length} pages; the limit is ${MAX_PAGES}.`);
      const bytes = await build(needKept(doc), signal, progress);
      return [{ name: `${baseName(doc.file.name)}-organized.pdf`, blob: pdfBlob(bytes), inputSize: doc.file.size, note: doc.signed ? SIGNATURE_NOTE : undefined }];
    },
    async merge(signal, progress) {
      if (docs.length < 2) throw new UserError('Add at least two PDFs to merge.');
      const total = docs.reduce((s, d) => s + d.file.size, 0);
      if (total > MAX_TOTAL) throw new UserError('Total size exceeds 200 MB.');
      const pages = docs.flatMap(kept);
      if (!pages.length) throw new UserError('All pages are deleted. Restore at least one page.');
      const bytes = await build(pages, signal, progress);
      const note = 'Bookmarks and form fields may not be preserved.' + (docs.some((d) => d.signed) ? ' ' + SIGNATURE_NOTE : '');
      return [{ name: 'merged.pdf', blob: pdfBlob(bytes), inputSize: total, note }];
    },
    async split(signal, progress) {
      const doc = needDoc();
      if (doc.file.size > MAX_ONE) throw new UserError('This PDF is larger than 100 MB.');
      const pages = needKept(doc);
      const how = new FormData(splitForm).get('split');
      let groups: Page[][];
      if (how === 'each') groups = pages.map((p) => [p]);
      else {
        groups = parseRanges(rangesInput.value, pages.length).map((g) => g.map((i) => pages[i]));
        if (how === 'extract') groups = [groups.flat()];
      }
      const base = baseName(doc.file.name);
      const out: Result[] = [];
      for (const [i, g] of groups.entries()) {
        throwIfAborted(signal);
        progress(`Creating PDF ${i + 1} of ${groups.length}`, i / groups.length);
        const a = pages.indexOf(g[0]) + 1;
        const b = pages.indexOf(g[g.length - 1]) + 1;
        const name = how === 'extract' ? `${base}-extract.pdf` : `${base}-${a === b ? `p${a}` : `p${a}-${b}`}.pdf`;
        out.push({ name, blob: pdfBlob(await build(g, signal)) });
      }
      if (doc.signed) out[0].note = SIGNATURE_NOTE;
      if (out.length > 1) {
        progress('Packing ZIP…');
        // Names can repeat when ranges repeat; keep every file.
        const entries: Record<string, [Uint8Array, { level: 0 }]> = {};
        for (const r of out) {
          let name = r.name;
          for (let k = 2; name in entries; k++) name = r.name.replace(/\.pdf$/, `-${k}.pdf`);
          entries[name] = [new Uint8Array(await r.blob.arrayBuffer()), { level: 0 }];
        }
        out.unshift({ name: `${base}-split.zip`, blob: new Blob([zipSync(entries) as BlobPart], { type: 'application/zip' }), note: `All ${out.length} PDFs` });
      }
      return out;
    },
    async 'from-images'(signal, progress) {
      if (!images.length) throw new UserError('Add JPEG or PNG images first.');
      if (images.length > MAX_IMAGES) throw new UserError(`Up to ${MAX_IMAGES} images per PDF.`);
      const o = imgOptions();
      const { PDFDocument } = await import('@cantoo/pdf-lib');
      const pdf = await PDFDocument.create();
      for (const [i, img] of images.entries()) {
        throwIfAborted(signal);
        progress(`Adding ${img.file.name}`, i / images.length);
        await tick();
        const bytes = new Uint8Array(await img.file.arrayBuffer());
        let embedded;
        try {
          // JPEG bytes are embedded as-is (DCTDecode), so there is no quality loss.
          embedded = img.jpeg ? await pdf.embedJpg(bytes) : await pdf.embedPng(bytes);
        } catch {
          throw new UserError(`“${img.file.name}” could not be read. It may be damaged or use an unsupported variant.`);
        }
        const g = imageLayout({ w: embedded.width, h: embedded.height }, o);
        pdf.addPage([g.pw, g.ph]).drawImage(embedded, { x: g.x, y: g.y, width: g.w, height: g.h });
      }
      progress('Saving…');
      const bytes = await pdf.save({ useObjectStreams: true });
      return [{ name: 'images.pdf', blob: pdfBlob(bytes), inputSize: images.reduce((s, i) => s + i.file.size, 0) }];
    },
    async compress(signal, progress) {
      const doc = needDoc();
      const f = doc.file;
      if (f.size > MAX_ONE) throw new UserError('File exceeds 100 MB.');
      const changedPages = doc.pages.some((p, i) => p.index !== i || p.rot || p.deleted);
      const input = changedPages ? await build(needKept(doc), signal, progress) : new Uint8Array(await f.arrayBuffer());
      progress('Loading optimizer…');
      // Dynamic: qpdf glue + wasm are large; load only when the user runs it.
      const { default: createQpdf } = await import('@neslinesli93/qpdf-wasm');
      const qpdf = await createQpdf({ locateFile: () => qpdfWasmUrl });
      // Shipped typings omit these standard Emscripten FS calls.
      const fs = qpdf.FS as typeof qpdf.FS & { writeFile(path: string, data: Uint8Array): void; unlink(path: string): void };
      throwIfAborted(signal);
      progress('Optimizing…');
      await tick();
      fs.writeFile('/in.pdf', input);
      let out: Uint8Array;
      try {
        // Exit 3 = succeeded with warnings.
        const rc = qpdf.callMain(['--object-streams=generate', '--compress-streams=y', '--recompress-flate', '--compression-level=9', '/in.pdf', '/out.pdf']);
        if (rc !== 0 && rc !== 3) throw new UserError('This PDF could not be optimized. It may be damaged.');
        out = fs.readFile('/out.pdf');
      } finally {
        for (const p of ['/in.pdf', '/out.pdf'])
          try {
            fs.unlink(p);
          } catch {}
      }
      throwIfAborted(signal);
      const sig = doc.signed ? ' ' + SIGNATURE_NOTE : '';
      if (out.length >= input.length) {
        if (!changedPages) return [{ name: f.name, blob: f, inputSize: f.size, note: 'Already optimized — no smaller version found' }];
        return [{ name: `${baseName(f.name)}-organized.pdf`, blob: pdfBlob(input), inputSize: f.size, note: `Optimizing found nothing smaller; this is your edited copy.${sig}` }];
      }
      return [{ name: `${baseName(f.name)}-optimized.pdf`, blob: pdfBlob(out), inputSize: f.size, note: (changedPages ? 'Includes your page changes.' : '') + sig || undefined }];
    },
  };

  async function run(): Promise<boolean> {
    if (controller || !items().length) return false;
    controller = new AbortController();
    clearResults();
    notify('');
    showBusy('Working…', true);
    panel();
    try {
      results = await runners[mode](controller.signal, (text, fraction) => {
        busyText.textContent = text;
        setDial(dial, fraction);
      });
      showResults();
      return true;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') notify('Cancelled.');
      else {
        if (!(err instanceof UserError)) console.error(err);
        notify(errorText(err), 'error');
      }
      return false;
    } finally {
      controller = undefined;
      busy.hidden = true;
      panel();
    }
  }

  function showBusy(text: string, cancellable = false) {
    busyText.textContent = text;
    setDial(dial);
    dial.hidden = false;
    busyCancel.hidden = !cancellable;
    busy.hidden = false;
  }

  function clearResults() {
    urls.forEach((u) => URL.revokeObjectURL(u));
    urls = [];
    results = [];
    resultList.replaceChildren();
    resultsBox.hidden = true;
  }

  function showResults() {
    resultsTitle.textContent = results.length === 1 ? 'Result' : `${results.length} results`;
    resultList.replaceChildren(
      ...results.map((r) => {
        const url = URL.createObjectURL(r.blob);
        urls.push(url);
        let delta = '';
        if (r.inputSize) {
          const pct = Math.round((r.blob.size / r.inputSize - 1) * 100);
          delta = pct === 0 ? ' · same size' : pct < 0 ? ` · ${-pct}% smaller` : ` · ${pct}% larger`;
        }
        const meta = el('p', { className: 'pa-res-meta', textContent: `${formatBytes(r.blob.size)}${delta}` });
        meta.toggleAttribute('data-warn', !!r.inputSize && r.blob.size > r.inputSize && !r.note);
        const actions = el('div', { className: 'pa-res-actions' });
        if (r.blob.type === 'application/pdf') {
          const open = el('button', { type: 'button', className: 'btn', title: 'Open this file in the viewer', ariaLabel: `Open ${r.name} in the viewer` });
          open.append(icon('open'), 'Open');
          open.addEventListener('click', () => void addFiles([new File([r.blob], r.name, { type: 'application/pdf' })], true));
          actions.append(open);
        }
        const link = el('a', { className: 'btn btn-primary', href: url, download: r.name, ariaLabel: `Download ${r.name}` });
        link.append(icon('download'), 'Download');
        actions.append(link);
        return el('li', {}, el('div', { className: 'pa-res-body' }, el('p', { className: 'pa-res-name', textContent: r.name }), meta, ...(r.note ? [el('p', { className: 'pa-res-note', textContent: r.note })] : [])), actions);
      }),
    );
    resultsBox.hidden = false;
    resultList.querySelector<HTMLElement>('a.btn')?.focus();
    say(`${results.length === 1 ? 'Result' : `${results.length} results`} ready.`);
  }

  // ---------- Wiring ----------
  input.addEventListener('change', () => {
    void addFiles([...(input.files ?? [])]);
    input.value = '';
  });
  $('[data-open]').addEventListener('click', () => input.click());
  closeAll.addEventListener('click', () => {
    for (const d of [...docs]) closeDoc(d);
    removeImages([...images]);
    selected.clear();
    current = undefined;
    notify('');
    changed();
  });
  root.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    root.classList.add('pa-over');
  });
  root.addEventListener('dragleave', (e) => {
    if (!root.contains(e.relatedTarget as Node | null)) root.classList.remove('pa-over');
  });
  root.addEventListener('drop', (e) => {
    root.classList.remove('pa-over');
    if (!e.dataTransfer?.files.length) return;
    e.preventDefault();
    void addFiles([...e.dataTransfer.files]);
  });
  document.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files ?? [])];
    if (!files.length) return;
    e.preventDefault();
    void addFiles(files);
  });

  for (const r of root.querySelectorAll<HTMLInputElement>('input[name="pa-mode"]')) r.addEventListener('change', () => setMode(r.value as Mode, true));
  for (const b of root.querySelectorAll<HTMLButtonElement>('[data-act]')) b.addEventListener('click', () => act(b.dataset.act!));
  $('[data-zoom-in]').addEventListener('click', () => stepZoom(1));
  $('[data-zoom-out]').addEventListener('click', () => stepZoom(-1));
  zoomSel.addEventListener('change', () => setZoom(zoomSel.value === 'width' || zoomSel.value === 'page' ? zoomSel.value : Number(zoomSel.value)));
  pageInput.addEventListener('change', () => {
    const all = items();
    const it = all[Math.max(1, Math.min(all.length, Math.round(Number(pageInput.value)) || 1)) - 1];
    if (it) select(it, 'only', true);
  });
  $('[data-msg-close]').addEventListener('click', () => notify(''));
  $('[data-results-close]').addEventListener('click', clearResults);
  busyCancel.addEventListener('click', () => controller?.abort());
  runBtn.addEventListener('click', () => void run());
  dlBtn.addEventListener('click', async () => {
    if (!results.length && !(await run())) return;
    downloadBlob(results[0].blob, results[0].name);
  });
  splitForm.addEventListener('submit', (e) => e.preventDefault());
  splitForm.addEventListener('input', () => {
    clearResults();
    splitSummary();
  });
  rangesInput.addEventListener('keydown', (e) => e.key === 'Enter' && void run());
  useSel.addEventListener('click', () => {
    rangesInput.value = selectionRanges();
    const how = splitForm.elements.namedItem('split') as RadioNodeList;
    if (how.value === 'each') how.value = 'extract';
    clearResults();
    splitSummary();
  });
  imgForm.addEventListener('change', () => {
    clearResults();
    layout();
  });

  const requested = new URLSearchParams(location.search).get('mode') as Mode | null;
  setMode(requested && MODES.includes(requested) ? requested : 'organize', !!requested && MODES.includes(requested));
  changed();
}
