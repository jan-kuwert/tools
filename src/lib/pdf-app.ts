// PDF app (src/pages/pdf/index.astro): one combined document. Every PDF and image (JPEG/PNG) dropped in adds its pages
// to a single page order that the sidebar, grid and page view edit (reorder across files, rotate, delete/restore).
// Export writes that order as one PDF (standard, qpdf-optimized, or redrawn as JPEG pages for Lossy / Black & white);
// Split writes parts of it plus a ZIP.
// pdf-lib (~500 KB), pdf.js and qpdf (wasm) are imported dynamically on first use to keep first paint instant.
import { zipSync } from 'fflate';
import type { PDFDocument } from '@cantoo/pdf-lib';
import type * as PdfJs from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFWorker } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import qpdfWasmUrl from '@neslinesli93/qpdf-wasm/dist/qpdf.wasm?url';
import { downloadBlob, el, formatBytes, publishOutput, setDial, sniff, throwIfAborted, tick, UserError, type Result } from './tool';
import { loadPdf, parseRanges, pdfBlob } from './pdf';
import { resizable } from './resize';

type ViewKind = 'pages' | 'grid';
type Tile = 'thumb' | 'card';
const MB = 1024 * 1024;
const MAX_TOTAL = 200 * MB;
const MAX_IMAGES = 100;
/** CSS px per PDF point at 100 % (96 dpi screen, 72 pt per inch). */
const PT = 96 / 72;
const ZOOMS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
/** Canvas backing-store cap per page (~64 MB of RGBA). */
const MAX_CANVAS_PX = 16e6;
const PAD = 22;
/** Grid card width range in CSS px (the slider's limits). */
const CARD_MIN = 96;
const CARD_MAX = 360;
// PDF points (1/72 in), as in src/pages/pdf/from-images.astro.
const SIZES = { a4: [595.28, 841.89], letter: [612, 792] } as const;
/** Source markers cycle through this many palette entries (--fm-0 … in the page CSS). */
const HUES = 8;
/** Above this much source data the exact export size is only computed on export. */
const EST_MAX = 100 * MB;
/** Below this, the Optimized size is computed in the background as well (qpdf runs synchronously). */
const OPT_EST_MAX = 20 * MB;
/** Named paper sizes in points (short side, long side). */
const PAPER: [string, number, number][] = [
  ['A3', 841.89, 1190.55],
  ['A4', 595.28, 841.89],
  ['A5', 419.53, 595.28],
  ['Letter', 612, 792],
  ['Legal', 612, 1008],
];
/** Lossy export presets: render resolution (dpi) and JPEG quality. */
const LOSSY = { low: [72, 0.5], medium: [110, 0.6], high: [150, 0.75] } as const;

/** One loaded file (PDF or image) with its legend row in the sidebar. */
interface Source {
  file: File;
  /** Marker slot: colour and letter. */
  slot: number;
  head: HTMLElement;
  count: HTMLElement;
  up: HTMLButtonElement;
  down: HTMLButtonElement;
}
interface Doc extends Source {
  lib: PDFDocument;
  signed: boolean;
  proxy?: PDFDocumentProxy;
  /** Pages in file order. */
  pages: Page[];
}
/** The three representations of one page: sidebar thumbnail, grid card, page view sheet. */
interface Tiles {
  thumb: HTMLLIElement;
  label: HTMLElement;
  card: HTMLLIElement;
  cardLabel: HTMLElement;
  cardDel: HTMLButtonElement;
  view: HTMLElement;
  art: HTMLElement;
  cardArt: HTMLElement;
  /** User rotation on top of the page's own. */
  rot: number;
  deleted: boolean;
}
interface Page extends Tiles {
  doc: Doc;
  index: number;
  /** CropBox size in points, unrotated. */
  w: number;
  h: number;
  /** /Rotate from the file. */
  base: number;
  /** CSS px size the thumbnail / card was (or is queued to be) rendered at; 0 = none. */
  thumbPx: number;
  cardPx: number;
  /** Scale/rotation the view canvas was rendered for. */
  key: string;
}
/** An image file: its own source and a single page. */
interface Img extends Tiles, Source {
  url: string;
  jpeg: boolean;
  /** Stored pixel size (what pdf-lib embeds; EXIF orientation is not applied). */
  w: number;
  h: number;
  /** Unrotated page sheet inside the view, rotated as a whole. */
  sheet: HTMLElement;
  pic: HTMLImageElement;
}
type Item = Page | Img;
const isPage = (i: Item): i is Page => 'doc' in i;
const isDoc = (s: Source): s is Doc => 'lib' in s;
const srcOf = (i: Item): Doc | Img => (isPage(i) ? i.doc : i);
interface ImgOptions {
  size: 'a4' | 'letter' | 'fit';
  orientation: string;
  margin: number;
}

const letter = (slot: number) => (slot < 26 ? String.fromCharCode(65 + slot) : String(slot + 1));
const session = (key: string, value?: string): string | null => {
  try {
    if (value === undefined) return sessionStorage.getItem(key);
    sessionStorage.setItem(key, value);
  } catch {
    // Storage blocked (privacy mode, sandbox): the choice just isn't remembered.
  }
  return null;
};
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export function initPdfApp(): void {
  const root = document.querySelector<HTMLElement>('[data-pdf-app]')!;
  const $ = <T extends Element = HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  const input = $<HTMLInputElement>('[data-input]');
  const side = $('[data-side]');
  const legendList = $('[data-legend]');
  const legendNote = $('[data-legend-note]');
  const thumbList = $<HTMLOListElement>('[data-thumbs]');
  const view = $('[data-view]');
  const pagesBox = $('[data-pages]');
  const grid = $('[data-grid]');
  const cardList = $<HTMLOListElement>('[data-cards]');
  const viewRadios = [...root.querySelectorAll<HTMLInputElement>('input[name="pa-view"]')];
  const sizeInput = $<HTMLInputElement>('[data-card-size]');
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
  const splitSection = $('[data-split]');
  const splitForm = $<HTMLFormElement>('[data-split-form]');
  const splitBtn = $<HTMLButtonElement>('[data-split-run]');
  const imgForm = $<HTMLFormElement>('[data-img-form]');
  const exportForm = $<HTMLFormElement>('[data-export-form]');
  const exportBtn = $<HTMLButtonElement>('[data-export]');
  const exportInfo = $('[data-export-info]');
  const nameInput = exportForm.elements.namedItem('filename') as HTMLInputElement;
  const rangesField = $('[data-ranges-field]');
  const rangesInput = splitForm.elements.namedItem('ranges') as HTMLInputElement;
  const useSel = $<HTMLButtonElement>('[data-use-selection]');
  const splitInfo = $('[data-split-info]');
  const sigBox = $('[data-sig]');
  const orderInfo = $('[data-order-info]');
  const selInfo = $('[data-sel-info]');
  const announce = $('[data-announce]');
  const icons = $<HTMLTemplateElement>('[data-icons]').content;
  const icon = (name: string) => icons.querySelector(`.i-${name}`)!.cloneNode(true);

  /** Loaded files in legend order. */
  let sources: (Doc | Img)[] = [];
  /** The combined page order (the output order). */
  let order: Item[] = [];
  let current: Item | undefined;
  let selected = new Set<Item>();
  let anchor: Item | undefined;
  let zoom: 'width' | 'page' | number = 'width';
  let scale = 1;
  let cardSize = Math.min(CARD_MAX, Math.max(CARD_MIN, Number(session('pdf.card')) || 168));
  let results: Result[] = [];
  let urls: string[] = [];
  let controller: AbortController | undefined;
  let pdfjs: typeof PdfJs | undefined;
  let worker: PDFWorker | undefined;
  /** The user typed a file name; stop suggesting one. */
  let nameEdited = false;
  /** Bumped on every change to what Export would write; background estimates from older generations are discarded. */
  let gen = 0;
  let estimateCtl: AbortController | undefined;
  let estimateTimer = 0;
  /** Export bytes for generation `gen`, reused by Export when nothing changed since. */
  let cache: { gen: number; standard: Uint8Array; optimized?: Uint8Array } | undefined;
  /** Set for the click that ends a drag, so it doesn't change the selection. */
  let suppressClick = false;
  const itemOf = new WeakMap<Element, Item>();

  const say = (text: string) => (announce.textContent = text);
  const docs = () => sources.filter(isDoc);
  const images = () => sources.filter((s): s is Img => !isDoc(s));
  const kept = () => order.filter((i) => !i.deleted);
  const isGrid = () => root.dataset.view === 'grid';
  const focusZone = (): 'side' | 'grid' | undefined => (side.contains(document.activeElement) ? 'side' : grid.contains(document.activeElement) ? 'grid' : undefined);
  const tileOf = (it: Item, zone: 'side' | 'grid') => (zone === 'grid' ? it.card : it.thumb);
  const sync = (parent: Element, children: Element[]) => {
    if (children.length !== parent.children.length || children.some((c, i) => parent.children[i] !== c)) parent.replaceChildren(...children);
  };
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

  function notify(text: string, kind: 'info' | 'error' = 'info') {
    msg.dataset.kind = kind;
    msgText.textContent = text;
    msg.hidden = !text;
  }
  const errorText = (err: unknown) => (err instanceof UserError ? err.message : `Something went wrong: ${(err as Error)?.message ?? err}`);

  /** Scroll `scroller` just enough to show `target`, without moving any outer scroll container. */
  function reveal(target: HTMLElement, scroller: HTMLElement) {
    if (!target.offsetParent) return;
    const r = target.getBoundingClientRect();
    const s = scroller.getBoundingClientRect();
    if (r.top < s.top) scroller.scrollTop += r.top - s.top - 8;
    else if (r.bottom > s.bottom) scroller.scrollTop += r.bottom - s.bottom + 8;
  }

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

  const nextSlot = () => {
    let s = 0;
    while (sources.some((x) => x.slot === s)) s++;
    return s;
  };

  async function openPdf(file: File): Promise<Doc> {
    const loaded = await loadPdf(file);
    if (!loaded.doc.getPageCount()) throw new UserError(`“${file.name}” has no pages.`);
    const doc: Doc = { ...legendRow(file, nextSlot()), lib: loaded.doc, signed: loaded.hasSignature, pages: [] };
    wireSource(doc);
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
      if (!sources.includes(doc)) return void proxy.loadingTask.destroy();
      doc.proxy = proxy;
      for (const p of doc.pages) {
        if (visible.has(p)) want(p);
        if (seen.thumb.has(p)) queueTile(p, 'thumb');
        if (seen.card.has(p)) queueTile(p, 'card');
      }
    } catch {
      for (const p of doc.pages) {
        for (const a of [p.art, p.cardArt]) a.firstElementChild?.setAttribute('data-failed', '');
        p.view.dataset.failed = '';
      }
    }
  }

  async function addFiles(files: File[]) {
    if (!files.length || controller) return;
    const errors: string[] = [];
    let first: Item | undefined;
    showBusy('Opening…');
    try {
      for (const f of files) {
        busyText.textContent = `Opening ${f.name}…`;
        await tick();
        const kind = await sniff(f);
        try {
          if (kind === 'pdf') {
            const total = docs().reduce((s, d) => s + d.file.size, 0) + f.size;
            if (total > MAX_TOTAL) throw new UserError(`“${f.name}” would bring the PDFs over 200 MB in total.`);
            const doc = await openPdf(f);
            sources.push(doc);
            order.push(...doc.pages);
            void attachPreview(doc);
            first ??= doc.pages[0];
          } else if (kind === 'jpeg' || kind === 'png') {
            if (images().length >= MAX_IMAGES) throw new UserError(`“${f.name}” not added: up to ${MAX_IMAGES} images.`);
            const img = await openImage(f, kind === 'jpeg');
            sources.push(img);
            order.push(img);
            first ??= img;
          } else throw new UserError(`“${f.name}” is not a PDF, JPEG or PNG.`);
        } catch (err) {
          errors.push(errorText(err));
        }
      }
    } finally {
      busy.hidden = true;
    }
    if (first) {
      changed();
      select(first, 'only', true);
    }
    notify(errors.join('\n'), 'error');
  }

  /** Small letter badge marking the source file; colour comes from the element's --fm. */
  function marker(slot: number, name: string): HTMLElement {
    const m = el('span', { className: 'pa-mark', textContent: letter(slot), title: `${letter(slot)}: ${name}` });
    m.setAttribute('aria-hidden', 'true');
    return m;
  }
  const tint = (e: HTMLElement, slot: number) => e.style.setProperty('--fm', `var(--fm-${slot % HUES})`);

  /** Sidebar legend row: marker, name (click selects the file's pages), count, move and close. */
  function legendRow(file: File, slot: number): Source {
    const btn = (label: string, name: string) => {
      const b = el('button', { type: 'button', className: 'pa-tool', ariaLabel: `${label}: ${file.name}`, title: label });
      b.append(icon(name));
      return b;
    };
    const count = el('span', { className: 'pa-src-count' });
    const name = el('button', { type: 'button', className: 'pa-src-name', title: `Select the pages of ${file.name}` }, marker(slot, file.name), el('span', { textContent: file.name }), count);
    name.dataset.pick = '';
    const up = btn('Move file up', 'up');
    up.dataset.move = '-1';
    const down = btn('Move file down', 'down');
    down.dataset.move = '1';
    const close = btn('Close file', 'close');
    close.dataset.close = '';
    const head = el('li', { className: 'pa-src' }, name, up, down, close);
    tint(head, slot);
    return { file, slot, head, count, up, down };
  }

  function wireSource(src: Doc | Img) {
    src.head.querySelector('[data-pick]')!.addEventListener('click', () => {
      const mine = order.filter((i) => srcOf(i) === src);
      selected = new Set(mine);
      anchor = mine[0];
      setCurrent(mine[0]);
      paintSelection();
      scrollToItem(mine[0]);
    });
    for (const b of src.head.querySelectorAll<HTMLButtonElement>('[data-move]'))
      b.addEventListener('click', () => {
        // Only offered while each file's pages are contiguous: swaps whole blocks.
        const i = sources.indexOf(src);
        const to = i + Number(b.dataset.move);
        if (to < 0 || to >= sources.length) return;
        sources.splice(i, 1);
        sources.splice(to, 0, src);
        animate(() => {
          order.splice(0, order.length, ...sources.flatMap((s) => order.filter((p) => srcOf(p) === s)));
          changed();
        });
        (b.disabled ? (b === src.up ? src.down : src.up) : b).focus();
        say(`${src.file.name} moved to position ${to + 1} of ${sources.length}.`);
      });
    src.head.querySelector('[data-close]')!.addEventListener('click', () => {
      closeSource(src);
      changed();
      say(`${src.file.name} closed.`);
    });
  }

  function createTiles(slot: number, name: string, art: HTMLElement, cardArt: HTMLElement): Tiles {
    const label = el('span', { className: 'pa-thumb-label' });
    const thumb = el('li', { className: 'pa-thumb', role: 'option', tabIndex: -1 }, el('span', { className: 'pa-thumb-box' }, art, marker(slot, name)), label);
    const actions = el('span', { className: 'pa-card-actions' });
    // Mouse shortcuts only: keyboard users have R, Shift+R and Delete on the focused card.
    const btn = (act: string, title: string, ic: string) => {
      const b = el('button', { type: 'button', className: 'pa-card-btn', title, ariaLabel: title, tabIndex: -1 });
      b.dataset.act = act;
      b.append(icon(ic));
      actions.append(b);
      return b;
    };
    btn('rotate-left', 'Rotate left', 'rotate-left');
    btn('rotate-right', 'Rotate right', 'rotate-right');
    const cardDel = btn('delete', 'Delete', 'trash');
    const cardLabel = el('span', { className: 'pa-card-label' });
    const card = el('li', { className: 'pa-card', role: 'option', tabIndex: -1 }, el('span', { className: 'pa-card-box' }, cardArt, marker(slot, name)), cardLabel, actions);
    const view = el('div', { className: 'pa-page', role: 'img' }, marker(slot, name));
    for (const e of [thumb, card, view]) tint(e, slot);
    return { thumb, label, card, cardLabel, cardDel, view, art, cardArt, rot: 0, deleted: false };
  }

  async function openImage(file: File, jpeg: boolean): Promise<Img> {
    const { w, h } = await pixelSize(file, jpeg);
    const url = URL.createObjectURL(file);
    const picture = () => el('img', { src: url, alt: '', draggable: false });
    const slot = nextSlot();
    const t = createTiles(slot, file.name, el('span', { className: 'pa-art' }, picture()), el('span', { className: 'pa-art' }, picture()));
    const pic = picture();
    const sheet = el('div', { className: 'pa-sheet' }, pic);
    t.view.prepend(sheet);
    t.thumb.title = t.card.title = file.name;
    const img: Img = { ...t, ...legendRow(file, slot), url, jpeg, w, h, sheet, pic };
    wireSource(img);
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

  function createPage(doc: Doc, index: number, w: number, h: number, base: number): Page {
    // Placeholder sheet with the page's shape until the preview renders.
    const [tw, th] = base % 180 ? [h, w] : [w, h];
    const paper = () => {
      const s = el('span', { className: 'pa-paper' });
      s.style.aspectRatio = `${tw} / ${th}`;
      s.style[tw >= th ? 'width' : 'height'] = '100%';
      return s;
    };
    const t = createTiles(doc.slot, doc.file.name, el('span', { className: 'pa-art' }, paper()), el('span', { className: 'pa-art' }, paper()));
    t.card.title = `${doc.file.name}, page ${index + 1}`;
    const page: Page = { ...t, doc, index, w, h, base, thumbPx: 0, cardPx: 0, key: '' };
    wireItem(page);
    viewObserver.observe(page.view);
    tileObservers.thumb.observe(page.thumb);
    tileObservers.card.observe(page.card);
    return page;
  }

  function closeSource(src: Doc | Img) {
    if (isDoc(src)) {
      void src.proxy?.loadingTask.destroy();
      src.proxy = undefined;
      for (const p of src.pages) {
        visible.delete(p);
        seen.thumb.delete(p);
        seen.card.delete(p);
        viewObserver.unobserve(p.view);
        tileObservers.thumb.unobserve(p.thumb);
        tileObservers.card.unobserve(p.card);
      }
    } else URL.revokeObjectURL(src.url);
    for (const i of order) if (srcOf(i) === src) selected.delete(i);
    sources = sources.filter((s) => s !== src);
    order = order.filter((i) => srcOf(i) !== src);
    src.head.remove();
  }

  // ---------- Selection & keyboard (sidebar thumbnails and grid cards) ----------
  function wireItem(item: Item) {
    for (const [tile, zone] of [
      [item.thumb, 'side'],
      [item.card, 'grid'],
    ] as const) {
      itemOf.set(tile, item);
      tile.addEventListener('click', (e) => {
        if (suppressClick) return;
        if (e.shiftKey) select(item, 'range');
        else if (e.ctrlKey || e.metaKey) select(item, 'toggle');
        else select(item, 'only', zone === 'side');
      });
      tile.addEventListener('keydown', (e) => onItemKey(e, item, zone));
    }
    itemOf.set(item.view, item);
    item.card.addEventListener('dblclick', (e) => {
      if (!(e.target as Element).closest('button')) openInPages(item);
    });
    for (const b of item.card.querySelectorAll<HTMLButtonElement>('.pa-card-btn')) {
      b.addEventListener('pointerdown', (e) => e.stopPropagation());
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!selected.has(item)) select(item, 'only');
        act(b.dataset.act!);
      });
    }
  }

  /** Columns in the grid's current layout (cards sharing the first card's row). */
  function gridCols(): number {
    const cards = order.map((i) => i.card);
    const top = cards[0]?.offsetTop;
    const n = cards.findIndex((c) => c.offsetTop !== top);
    return n < 0 ? cards.length || 1 : n;
  }

  function onItemKey(e: KeyboardEvent, item: Item, zone: 'side' | 'grid') {
    const i = order.indexOf(item);
    const cols = zone === 'grid' ? gridCols() : 1;
    const mod = e.ctrlKey || e.metaKey;
    const step = ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols } as Record<string, number>)[e.key];
    if (step !== undefined && e.altKey) moveSelection(step);
    else if (step !== undefined || e.key === 'Home' || e.key === 'End') {
      const to = e.key === 'Home' ? 0 : e.key === 'End' ? order.length - 1 : Math.max(0, Math.min(order.length - 1, i + step));
      // Ctrl/Cmd+arrows move focus only, so Space can add items one by one.
      if (mod) setCurrent(order[to], true);
      else select(order[to], e.shiftKey ? 'range' : 'only', true);
    } else if (e.key === ' ') select(item, 'toggle');
    else if (e.key === 'Enter') zone === 'grid' ? openInPages(item) : scrollToItem(item);
    else if (mod && e.key.toLowerCase() === 'a') act('select-all');
    else if (e.key === 'Delete' || e.key === 'Backspace') act('delete');
    else if (!mod && !e.altKey && e.key.toLowerCase() === 'r') act(e.shiftKey ? 'rotate-left' : 'rotate-right');
    else return;
    e.preventDefault();
  }

  /** `only`: just this item; `toggle`: add/remove; `range`: anchor..item. */
  function select(item: Item, how: 'only' | 'toggle' | 'range', scroll = false) {
    if (how === 'only') {
      selected = new Set([item]);
      anchor = item;
    } else if (how === 'toggle') {
      if (selected.has(item) && selected.size > 1) selected.delete(item);
      else selected.add(item);
      anchor = item;
    } else {
      const a = anchor && order.includes(anchor) ? order.indexOf(anchor) : order.indexOf(item);
      const b = order.indexOf(item);
      selected = new Set(order.slice(Math.min(a, b), Math.max(a, b) + 1));
    }
    setCurrent(item, true);
    paintSelection();
    if (scroll) scrollToItem(item);
  }

  function setCurrent(item: Item | undefined, focus = false) {
    current = item;
    for (const i of order)
      for (const t of [i.thumb, i.card]) {
        t.tabIndex = i === item ? 0 : -1;
        if (i === item) t.setAttribute('aria-current', 'true');
        else t.removeAttribute('aria-current');
      }
    if (item) {
      const zone = focusZone();
      if (focus && zone) tileOf(item, zone).focus({ preventScroll: true });
      reveal(item.thumb, side);
      if (isGrid()) reveal(item.card, grid);
    }
    const n = item ? order.indexOf(item) + 1 : 0;
    if (document.activeElement !== pageInput) pageInput.value = String(n || '');
  }

  function paintSelection() {
    for (const i of order) {
      const on = String(selected.has(i));
      i.thumb.setAttribute('aria-selected', on);
      i.card.setAttribute('aria-selected', on);
      i.view.toggleAttribute('data-selected', selected.has(i) && selected.size > 1);
    }
    panel();
  }

  /** Selected items in order, falling back to the current item. */
  function selection(): Item[] {
    const sel = order.filter((i) => selected.has(i));
    return sel.length ? sel : current ? [current] : [];
  }

  const countText = (sel: Item[]) => (sel.length === 1 ? 'Page' : `${sel.length} pages`);

  function act(name: string) {
    // Re-inserted nodes lose focus; remember where to put keyboard users back.
    const zone = focusZone();
    const sel = selection();
    if (!order.length) return;
    switch (name) {
      case 'rotate-left':
      case 'rotate-right':
        if (!sel.length) return;
        for (const p of sel) p.rot = (p.rot + (name === 'rotate-left' ? 270 : 90)) % 360;
        say(`${countText(sel)} rotated ${name === 'rotate-left' ? 'left' : 'right'}.`);
        changed();
        break;
      case 'up':
      case 'down':
        return moveSelection(name === 'up' ? -1 : 1);
      case 'delete': {
        if (!sel.length) return;
        const restore = sel.every((p) => p.deleted);
        for (const p of sel) p.deleted = !restore;
        say(`${countText(sel)} ${restore ? 'restored' : 'deleted'}.`);
        changed();
        break;
      }
      case 'select-all':
        selected = new Set(order);
        anchor = order[0];
        paintSelection();
        return;
      case 'reverse':
        animate(() => {
          order.reverse();
          changed();
        });
        say('Order reversed.');
        break;
      case 'reset':
        animate(() => {
          order.splice(0, order.length, ...sources.flatMap((s): Item[] => (isDoc(s) ? s.pages : [s])));
          for (const p of order) {
            p.rot = 0;
            p.deleted = false;
          }
          changed();
        });
        say('All page changes reset.');
        break;
    }
    if (zone && current) tileOf(current, zone).focus({ preventScroll: true });
  }

  /** Move the selection as one block by `by` positions (selected items end up adjacent). */
  function moveSelection(by: number) {
    const sel = selection();
    if (!sel.length) return;
    const zone = focusZone();
    const first = order.indexOf(sel[0]);
    const rest = order.filter((i) => !sel.includes(i));
    const at = Math.max(0, Math.min(rest.length, first + by));
    if (at === first && sel.every((s, k) => order[at + k] === s)) return;
    animate(() => {
      order.splice(0, order.length, ...rest.slice(0, at), ...sel, ...rest.slice(at));
      changed();
    });
    say(`${countText(sel)} moved to position ${at + 1} of ${order.length}.`);
    if (zone && current) {
      tileOf(current, zone).focus({ preventScroll: true });
      reveal(tileOf(current, zone), zone === 'grid' ? grid : side);
    }
  }

  /** Put `moving` (in order) before or after `target`. */
  function dropAt(moving: Item[], target: Item, after: boolean) {
    const block = order.filter((i) => moving.includes(i));
    const rest = order.filter((i) => !moving.includes(i));
    const at = rest.indexOf(target) + (after ? 1 : 0);
    animate(() => {
      order.splice(0, order.length, ...rest.slice(0, at), ...block, ...rest.slice(at));
      changed();
    });
    say(`${countText(block)} moved to position ${at + 1} of ${order.length}.`);
  }

  /** FLIP: run a reorder, then slide every visible thumbnail and card from its old place (transform only). */
  function animate(reorder: () => void) {
    const tiles = [...root.querySelectorAll<HTMLElement>('.pa-thumb, .pa-card')].filter((t) => t.offsetParent);
    const before = new Map(tiles.map((t) => [t, t.getBoundingClientRect()]));
    reorder();
    if (reducedMotion()) return;
    for (const [t, a] of before) {
      if (!t.offsetParent) continue;
      const b = t.getBoundingClientRect();
      const dx = a.left - b.left;
      const dy = a.top - b.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      t.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 220, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)' });
    }
  }

  // ---------- Drag to reorder (pointer events: mouse, pen, touch) ----------
  /** Reorder tiles inside `scroller` by dragging; touch needs a long press so normal swipes still scroll. */
  function reorderable(scroller: HTMLElement, zone: 'side' | 'grid') {
    const selector = zone === 'grid' ? '.pa-card' : '.pa-thumb';
    const indicator = el('div', { className: 'pa-insert' });
    indicator.hidden = true;
    scroller.append(indicator);
    interface Drag {
      item: Item;
      id: number;
      x: number;
      y: number;
      px: number;
      py: number;
      started: boolean;
      moved: boolean;
      timer: number;
      raf: number;
      moving: Item[];
      target?: Item;
      after: boolean;
      ghost?: HTMLElement;
    }
    let drag: Drag | undefined;

    scroller.addEventListener('pointerdown', (e) => {
      if (drag || e.button !== 0 || e.shiftKey || e.ctrlKey || e.metaKey) return;
      const t = e.target as Element;
      const tile = t.closest(selector);
      const item = tile && itemOf.get(tile);
      if (!item || t.closest('button')) return;
      drag = { item, id: e.pointerId, x: e.clientX, y: e.clientY, px: e.clientX, py: e.clientY, started: false, moved: false, timer: 0, raf: 0, moving: [], after: false };
      if (e.pointerType === 'touch') drag.timer = window.setTimeout(start, 350);
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', cancel);
    });
    // Once a touch drag has started, keep the browser from panning.
    scroller.addEventListener('touchmove', (e) => drag?.started && e.preventDefault(), { passive: false });
    scroller.addEventListener('contextmenu', (e) => drag && e.preventDefault());

    function start() {
      const d = drag;
      if (!d) return;
      d.started = true;
      if (!selected.has(d.item)) select(d.item, 'only');
      d.moving = order.filter((i) => selected.has(i));
      for (const m of d.moving) tileOf(m, zone).classList.add('pa-lifted');
      const one = d.item;
      d.ghost = el('div', { className: 'pa-ghost', textContent: d.moving.length > 1 ? countText(d.moving) : one.deleted ? 'Deleted page' : `Page ${kept().indexOf(one) + 1}` });
      root.append(d.ghost);
      root.classList.add('pa-dragging');
      window.addEventListener('keydown', esc);
      track();
      loop();
    }
    function move(e: PointerEvent) {
      const d = drag;
      if (!d || e.pointerId !== d.id) return;
      d.px = e.clientX;
      d.py = e.clientY;
      const dist = Math.hypot(d.px - d.x, d.py - d.y);
      if (!d.started) {
        // A touch that moves before the long press is a scroll, not a drag.
        if (e.pointerType === 'touch') return void (dist > 8 && finish(false));
        if (dist < 5) return;
        start();
      }
      if (dist > 8) d.moved = true;
      track();
    }
    function track() {
      const d = drag!;
      d.ghost!.style.translate = `${d.px + 14}px ${d.py + 12}px`;
      const candidates = order
        .filter((i) => !d.moving.includes(i))
        .map((i) => tileOf(i, zone))
        .filter((t) => t.offsetParent);
      let best: HTMLElement | undefined;
      let bestRect: DOMRect | undefined;
      let bestDist = Infinity;
      for (const t of candidates) {
        const r = t.getBoundingClientRect();
        const dx = Math.max(r.left - d.px, 0, d.px - r.right);
        const dy = Math.max(r.top - d.py, 0, d.py - r.bottom);
        if (dx * dx + dy * dy < bestDist) [best, bestRect, bestDist] = [t, r, dx * dx + dy * dy];
      }
      if (!best || !bestRect) {
        d.target = undefined;
        indicator.hidden = true;
        return;
      }
      const r = bestRect;
      const row = candidates.some((t) => t !== best && Math.abs(t.getBoundingClientRect().top - r.top) < 2);
      d.after = row ? d.px > r.left + r.width / 2 : d.py > r.top + r.height / 2;
      d.target = itemOf.get(best);
      const s = scroller.getBoundingClientRect();
      const ox = scroller.scrollLeft - s.left - scroller.clientLeft;
      const oy = scroller.scrollTop - s.top - scroller.clientTop;
      Object.assign(
        indicator.style,
        row
          ? { left: `${(d.after ? r.right + 1 : r.left - 4) + ox}px`, top: `${r.top + oy}px`, width: '3px', height: `${r.height}px` }
          : { left: `${r.left + ox}px`, top: `${(d.after ? r.bottom : r.top - 3) + oy}px`, width: `${r.width}px`, height: '3px' },
      );
      indicator.hidden = false;
    }
    // Auto-scroll while the pointer is near the top or bottom edge.
    function loop() {
      const d = drag;
      if (!d?.started) return;
      const s = scroller.getBoundingClientRect();
      const edge = Math.min(56, s.height / 4);
      const v = d.py < s.top + edge ? (d.py - s.top - edge) / edge : d.py > s.bottom - edge ? (d.py - s.bottom + edge) / edge : 0;
      if (v) {
        scroller.scrollTop += Math.max(-1, Math.min(1, v)) * 16;
        track();
      }
      d.raf = requestAnimationFrame(loop);
    }
    function up(e: PointerEvent) {
      if (drag && e.pointerId === drag.id) finish(true);
    }
    function cancel(e: PointerEvent) {
      if (drag && e.pointerId === drag.id) finish(false);
    }
    function esc(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      finish(false);
    }
    function finish(drop: boolean) {
      const d = drag;
      if (!d) return;
      drag = undefined;
      clearTimeout(d.timer);
      cancelAnimationFrame(d.raf);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', esc);
      indicator.hidden = true;
      d.ghost?.remove();
      root.classList.remove('pa-dragging');
      for (const m of d.moving) tileOf(m, zone).classList.remove('pa-lifted');
      if (!d.started) return;
      suppressClick = true;
      setTimeout(() => (suppressClick = false));
      if (drop && d.moved && d.target) dropAt(d.moving, d.target, d.after);
    }
  }

  // ---------- Layout ----------
  /** Rebuild sidebar, grid and view order, labels and sizes after any change to the files or pages. */
  function changed() {
    clearResults();
    root.toggleAttribute('data-empty', !order.length);
    root.toggleAttribute('data-multi', sources.length > 1);
    root.toggleAttribute('data-images', sources.some((s) => !isDoc(s)));
    closeAll.disabled = !sources.length;
    for (const c of root.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('[data-zoom-in], [data-zoom-out], [data-zoom], [data-page], [data-card-size]')) c.disabled = !order.length;
    if (current && !order.includes(current)) current = undefined;
    if (!current && order.length) setCurrent(order[0]);
    if (!order.length) setCurrent(undefined);

    // Legend: one row per file. While each file's pages are contiguous, the legend follows the page order and
    // rows can move whole files; once pages are mixed, "Group by file" puts them back together.
    const runs: (Doc | Img)[] = [];
    for (const i of order) if (runs[runs.length - 1] !== srcOf(i)) runs.push(srcOf(i));
    const mixed = runs.length > sources.length;
    root.toggleAttribute('data-mixed', mixed);
    if (!mixed) sources = runs;
    sync(legendList, sources.map((s) => s.head));
    legendNote.textContent = mixed ? `Pages from ${sources.length} files are mixed.` : '';
    sources.forEach((s, si) => {
      const pages = isDoc(s) ? s.pages : [s];
      const k = pages.filter((p) => !p.deleted).length;
      s.count.textContent = isDoc(s) ? `${k}${k < pages.length ? `/${pages.length}` : ''}` : k ? 'image' : 'deleted';
      s.up.hidden = s.down.hidden = sources.length < 2 || mixed;
      s.up.disabled = si === 0;
      s.down.disabled = si === sources.length - 1;
    });

    let n = 0;
    for (const p of order) {
      const pos = p.deleted ? 0 : ++n;
      const src = srcOf(p);
      p.label.textContent = p.cardLabel.textContent = p.deleted ? 'Deleted' : String(pos);
      const from = isPage(p) ? `${src.file.name}, page ${p.index + 1}` : src.file.name;
      const desc = `${p.deleted ? 'Deleted page' : `Page ${pos}`} (${sources.length > 1 ? `${letter(src.slot)}: ` : ''}${from})${p.rot ? `, rotated ${p.rot}°` : ''}`;
      p.thumb.ariaLabel = p.card.ariaLabel = p.view.ariaLabel = desc;
      for (const t of [p.thumb, p.card, p.view]) t.toggleAttribute('data-deleted', p.deleted);
      p.art.style.transform = p.cardArt.style.transform = p.rot ? `rotate(${p.rot}deg)` : '';
      if (p.cardDel.dataset.state !== String(p.deleted)) {
        p.cardDel.dataset.state = String(p.deleted);
        p.cardDel.title = p.cardDel.ariaLabel = p.deleted ? 'Restore' : 'Delete';
        p.cardDel.replaceChildren(icon(p.deleted ? 'restore' : 'trash'));
      }
    }

    sync(thumbList, order.map((i) => i.thumb));
    sync(cardList, order.map((i) => i.card));
    // Keep the current page where it is on screen while pages move around it.
    const before = current?.view.isConnected ? current.view.getBoundingClientRect().top : undefined;
    sync(pagesBox, order.map((i) => i.view));
    if (current && before !== undefined) view.scrollTop += current.view.getBoundingClientRect().top - before;
    pageCount.textContent = String(order.length);
    pageInput.max = String(Math.max(1, order.length));
    if (current) pageInput.value = String(order.indexOf(current) + 1);
    if (!nameEdited) nameInput.value = `${stem()}.pdf`;
    dirty();
    paintSelection();
    layout();
  }

  /** Displayed size in points, after rotation; for images, the page they become. */
  function dims(item: Item): { w: number; h: number } {
    const [w, h] = isPage(item) ? [item.w, item.h] : ((g) => [g.pw, g.ph])(imageLayout(item, imgOptions()));
    const turned = ((isPage(item) ? item.base : 0) + item.rot) % 180 !== 0;
    return turned ? { w: h, h: w } : { w, h };
  }

  function fitScale(): number {
    // Hidden (grid view): keep the last scale until the page view is shown again.
    if (!order.length || !view.clientWidth) return scale;
    const aw = view.clientWidth - 2 * PAD;
    const ah = view.clientHeight - 2 * PAD;
    if (zoom === 'width') return Math.max(0.1, aw / Math.max(...order.map((i) => dims(i).w)));
    const d = dims(current ?? order[0]);
    return Math.max(0.1, Math.min(aw / d.w, ah / d.h));
  }

  // Free zoom levels (pinch / Ctrl+wheel) show up as an extra option so the select always reflects the zoom.
  const customZoom = zoomSel.appendChild(new Option('', ''));
  customZoom.hidden = true;
  /** True while a pinch is in progress: pages are only resized (canvases stretch); rendering waits for it to settle. */
  let deferRender = false;

  function layout() {
    // Keep the current page at the same spot while the zoom changes.
    const anchorEl = current?.view;
    const ratio = anchorEl && anchorEl.offsetHeight ? (view.scrollTop - anchorEl.offsetTop) / anchorEl.offsetHeight : 0;
    const old = scale;
    scale = typeof zoom === 'number' ? zoom * PT : fitScale();
    const opts = imgOptions();
    for (const it of order) {
      const d = dims(it);
      it.view.style.width = `${Math.round(d.w * scale)}px`;
      it.view.style.height = `${Math.round(d.h * scale)}px`;
      if (!isPage(it)) {
        // The sheet is the unrotated page, turned as a whole; the picture sits on it as in the output.
        const g = imageLayout(it, opts);
        Object.assign(it.sheet.style, { width: `${Math.round(g.pw * scale)}px`, height: `${Math.round(g.ph * scale)}px`, transform: `translate(-50%, -50%) rotate(${it.rot}deg)` });
        Object.assign(it.pic.style, { left: `${(g.x / g.pw) * 100}%`, top: `${((g.ph - g.y - g.h) / g.ph) * 100}%`, width: `${(g.w / g.pw) * 100}%`, height: `${(g.h / g.ph) * 100}%` });
      }
    }
    if (anchorEl && scale !== old) view.scrollTop = anchorEl.offsetTop + ratio * anchorEl.offsetHeight;
    if (!deferRender) for (const p of visible) want(p);
    const pct = Math.round((scale / PT) * 100);
    zoomSel.options[0].textContent = zoom === 'width' ? `Fit width (${pct}%)` : 'Fit width';
    zoomSel.options[1].textContent = zoom === 'page' ? `Fit page (${pct}%)` : 'Fit page';
    customZoom.hidden = typeof zoom !== 'number' || ZOOMS.includes(zoom);
    if (!customZoom.hidden) Object.assign(customZoom, { value: String(zoom), textContent: `${pct}%` });
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

  /** Zoom by `factor` keeping the document point under (x, y) (client coords) fixed. */
  let settle = 0;
  function zoomAt(factor: number, x: number, y: number) {
    const z = Math.min(ZOOMS[ZOOMS.length - 1], Math.max(ZOOMS[0], (scale / PT) * factor));
    if (Math.abs(z - scale / PT) < 1e-4) return;
    const hit = order.find((it) => {
      const r = it.view.getBoundingClientRect();
      return y >= r.top && y <= r.bottom;
    });
    const before = hit?.view.getBoundingClientRect();
    const fx = before ? (x - before.left) / before.width : 0;
    const fy = before ? (y - before.top) / before.height : 0;
    deferRender = true;
    setZoom(Math.round(z * 1000) / 1000);
    if (hit && before) {
      const after = hit.view.getBoundingClientRect();
      view.scrollLeft += after.left + fx * after.width - x;
      view.scrollTop += after.top + fy * after.height - y;
    }
    clearTimeout(settle);
    settle = window.setTimeout(() => {
      deferRender = false;
      for (const p of visible) want(p);
    }, 160);
  }

  const wheelFactor = (e: WheelEvent) => Math.min(1.25, Math.max(0.8, Math.exp(-(e.deltaMode === WheelEvent.DOM_DELTA_LINE ? e.deltaY * 16 : e.deltaY) * 0.01)));
  // Trackpad pinch arrives as Ctrl+wheel (Chrome, Edge, Firefox); a mouse wheel with Ctrl/Cmd zooms too.
  // preventDefault stops the browser from zooming the whole page instead.
  view.addEventListener(
    'wheel',
    (e) => {
      if (!(e.ctrlKey || e.metaKey) || !order.length) return;
      e.preventDefault();
      zoomAt(wheelFactor(e), e.clientX, e.clientY);
    },
    { passive: false },
  );
  // Safari reports trackpad pinch as non-standard gesture events with a cumulative `scale`.
  type GestureEvt = UIEvent & { scale: number; clientX: number; clientY: number };
  let gestureScale = 1;
  for (const target of [view, grid])
    target.addEventListener('gesturestart', (e) => {
      e.preventDefault();
      gestureScale = 1;
    });
  view.addEventListener('gesturechange', (e) => {
    const g = e as GestureEvt;
    e.preventDefault();
    if (!order.length) return;
    zoomAt(g.scale / gestureScale, g.clientX, g.clientY);
    gestureScale = g.scale;
  });

  function scrollToItem(item: Item) {
    if (isGrid()) return reveal(item.card, grid);
    const top = item.view.offsetTop - PAD;
    view.scrollTo({ top, behavior: reducedMotion() ? 'auto' : 'smooth' });
    scrollTarget = item;
  }

  // ---------- Views: continuous pages | grid overview ----------
  function setView(v: ViewKind) {
    const zone = focusZone();
    const hadFocus = view.contains(document.activeElement) || grid.contains(document.activeElement);
    root.dataset.view = v;
    for (const r of viewRadios) r.checked = r.value === v;
    session('pdf.view', v);
    if (v === 'pages') {
      layout();
      if (current) view.scrollTop = current.view.offsetTop - PAD;
      if (hadFocus && zone !== 'side') view.focus({ preventScroll: true });
    } else {
      if (current) reveal(current.card, grid);
      if (hadFocus && current) current.card.focus({ preventScroll: true });
    }
  }

  function openInPages(item: Item) {
    select(item, 'only');
    setView('pages');
    view.focus({ preventScroll: true });
  }

  function setCardSize(px: number) {
    cardSize = Math.round(Math.min(CARD_MAX, Math.max(CARD_MIN, px)));
    grid.style.setProperty('--card', `${cardSize}px`);
    sizeInput.value = String(cardSize);
    session('pdf.card', String(cardSize));
    requeue('card');
  }
  // In the grid, pinch / Ctrl+wheel resizes the cards instead of zooming pages.
  grid.addEventListener(
    'wheel',
    (e) => {
      if (!(e.ctrlKey || e.metaKey) || !order.length) return;
      e.preventDefault();
      setCardSize(cardSize * wheelFactor(e));
    },
    { passive: false },
  );
  grid.addEventListener('gesturechange', (e) => {
    const g = e as GestureEvt;
    e.preventDefault();
    setCardSize(cardSize * (g.scale / gestureScale));
    gestureScale = g.scale;
  });

  // ---------- Rendering ----------
  const visible = new Set<Page>();
  const seen = { thumb: new Set<Page>(), card: new Set<Page>() };
  const viewQueue = new Set<Page>();
  const tileQueue: [Page, Tile][] = [];
  let rendering = 0;
  const keyOf = (p: Page) => `${scale.toFixed(4)}|${p.rot}`;

  const viewObserver = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const it = itemOf.get(e.target);
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
  const tileObserver = (kind: Tile, rootEl: HTMLElement) =>
    new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const it = itemOf.get(e.target);
          if (!it || !isPage(it) || !e.isIntersecting) continue;
          seen[kind].add(it);
          queueTile(it, kind);
        }
      },
      { root: rootEl, rootMargin: '300px 0px' },
    );
  const tileObservers = { thumb: tileObserver('thumb', side), card: tileObserver('card', grid) };

  function want(p: Page) {
    if (p.doc.proxy && p.key !== keyOf(p)) viewQueue.add(p);
    pump();
  }
  /** Thumbnails and cards render at their box size in 32 px steps, and only again when they need to grow. */
  function queueTile(p: Page, kind: Tile) {
    const w = (kind === 'thumb' ? p.thumb : p.card).firstElementChild!.clientWidth;
    if (!p.doc.proxy || !w) return;
    const px = Math.ceil(Math.max(64, w) / 32) * 32;
    if ((kind === 'thumb' ? p.thumbPx : p.cardPx) >= px) return;
    if (kind === 'thumb') p.thumbPx = px;
    else p.cardPx = px;
    if (!tileQueue.some(([q, k]) => q === p && k === kind)) tileQueue.push([p, kind]);
    pump();
  }
  /** After a size change settles, re-check the tiles already seen. */
  const timers: Record<Tile, number> = { thumb: 0, card: 0 };
  function requeue(kind: Tile) {
    clearTimeout(timers[kind]);
    timers[kind] = window.setTimeout(() => seen[kind].forEach((p) => queueTile(p, kind)), 200);
  }

  function pump() {
    while (rendering < 2 && (viewQueue.size || tileQueue.length)) {
      let job: Promise<void>;
      if (viewQueue.size) {
        const p = viewQueue.values().next().value!;
        viewQueue.delete(p);
        job = renderView(p);
      } else job = renderTile(...tileQueue.shift()!);
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

  async function renderTile(p: Page, kind: Tile) {
    const proxy = p.doc.proxy;
    if (!proxy || !sources.includes(p.doc)) return;
    const pg = await proxy.getPage(p.index + 1);
    const base = pg.getViewport({ scale: 1 });
    const px = (kind === 'thumb' ? p.thumbPx : p.cardPx) * Math.min(devicePixelRatio || 1, kind === 'thumb' ? 2 : 3);
    const viewport = pg.getViewport({ scale: px / Math.max(base.width, base.height) });
    const canvas = el('canvas', { width: Math.ceil(viewport.width), height: Math.ceil(viewport.height) });
    canvas.setAttribute('aria-hidden', 'true');
    await pg.render({ canvas, viewport }).promise;
    pg.cleanup();
    if (proxy === p.doc.proxy) (kind === 'thumb' ? p.art : p.cardArt).replaceChildren(canvas);
  }

  // Current page follows scrolling; a single selection follows along.
  let scrollTarget: Item | undefined;
  let scrollFrame = 0;
  view.addEventListener('scroll', () => {
    cancelAnimationFrame(scrollFrame);
    scrollFrame = requestAnimationFrame(() => {
      const line = view.scrollTop + view.clientHeight * 0.35;
      const at = order.find((it) => it.view.offsetTop + it.view.offsetHeight + 9 > line) ?? order[order.length - 1];
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
      const next = order[order.indexOf(current) + (e.key === 'ArrowLeft' ? -1 : 1)];
      if (next) select(next, 'only', true);
    } else return;
    e.preventDefault();
  });

  // ---------- Export summary & size estimate ----------
  const quality = () => new FormData(exportForm).get('quality') as 'standard' | 'optimized' | 'lossy';
  /** Settings for redrawing pages as JPEGs, or undefined for a vector export. */
  function rasterOpts(): { dpi: number; q: number; gray: boolean; label: string } | undefined {
    const d = new FormData(exportForm);
    const gray = d.get('color') === 'gray';
    // Black & white alone still has to redraw the pages; do it sharp enough for fine print.
    if (d.get('quality') !== 'lossy') return gray ? { dpi: 200, q: 0.85, gray, label: 'Black & white' } : undefined;
    const preset = d.get('preset') as keyof typeof LOSSY;
    const [dpi, q] = LOSSY[preset];
    return { dpi, q, gray, label: `Lossy (${preset} quality${gray ? ', black & white' : ''})` };
  }
  const outRot = [...root.querySelectorAll<HTMLElement>('[data-out-rot]')];

  /** The document changed: drop cached bytes, show the rough size now and compute the real one once edits pause. */
  function dirty() {
    gen++;
    cache = undefined;
    estimateCtl?.abort();
    estimateCtl = undefined;
    scheduleEstimate(800);
  }
  function scheduleEstimate(ms: number) {
    clearTimeout(estimateTimer);
    if (order.length) estimateTimer = window.setTimeout(() => void estimate(), ms);
  }

  async function estimate() {
    const g = gen;
    if (!kept().length || totalSize() > EST_MAX || controller) return;
    const ctl = (estimateCtl = new AbortController());
    try {
      if (cache?.gen !== g) {
        const standard = await build(kept(), ctl.signal);
        if (g !== gen) return;
        cache = { gen: g, standard };
        summary();
      }
      if (quality() === 'optimized' && !rasterOpts() && totalSize() < OPT_EST_MAX && cache && !cache.optimized) {
        const optimized = await optimize(cache.standard, ctl.signal, () => {});
        if (g !== gen || !cache) return;
        cache.optimized = optimized;
        summary();
      }
    } catch {
      // Cancelled or unreadable input: Export reports real problems.
    }
  }

  function paperName(w: number, h: number): [string, string] {
    const s = Math.min(w, h);
    const l = Math.max(w, h);
    const named = PAPER.find(([, a, b]) => Math.abs(a - s) < 3 && Math.abs(b - l) < 3)?.[0];
    const mm = (pt: number) => Math.round((pt / 72) * 25.4);
    return [named ?? `${mm(w)} × ${mm(h)} mm`, Math.abs(w - h) < 3 ? 'square' : w > h ? 'landscape' : 'portrait'];
  }

  /** Readout above the Export button: pages, files, page size, rotations and the (estimated) file size. */
  function summary() {
    const k = kept();
    const muted = (text: string) => el('span', { className: 'pa-muted', textContent: text });
    const deleted = order.length - k.length;
    $('[data-out-pages]').replaceChildren(String(k.length), ...(deleted ? [muted(`+${deleted} deleted`)] : []));
    const used = sources.filter((s) => k.some((i) => srcOf(i) === s));
    const badges = used.map((s) => {
      const m = marker(s.slot, s.file.name);
      tint(m, s.slot);
      return m;
    });
    $('[data-out-files]').replaceChildren(...badges, String(used.length));
    const papers = k.map((i) => paperName(dims(i).w, dims(i).h));
    const names = new Set(papers.map((p) => p.join(' ')));
    const bases = new Set(papers.map((p) => p[0]));
    $('[data-out-size]').textContent = !k.length ? '–' : names.size === 1 ? [...names][0] : bases.size === 1 ? `${[...bases][0]}, mixed orientation` : 'Mixed sizes';
    const rotated = k.filter((i) => i.rot).length;
    for (const e of outRot) e.hidden = !rotated;
    $('dd[data-out-rot]').textContent = String(rotated);

    const bytes = $('[data-out-bytes]');
    const fresh = cache?.gen === gen ? cache : undefined;
    // Rough guess until the real size is known: each file's size, prorated by its pages that are kept.
    const rough = sources.reduce((s, src) => {
      const pages = isDoc(src) ? src.pages : [src];
      return s + (src.file.size * pages.filter((p) => !p.deleted).length) / pages.length;
    }, 0);
    if (!k.length) bytes.replaceChildren('–');
    else if (totalSize() > EST_MAX && !fresh) bytes.replaceChildren(muted('calculated on export'));
    else if (rasterOpts()) bytes.replaceChildren(muted('calculated on export'));
    else if (!fresh) bytes.replaceChildren(`≈ ${formatBytes(rough)}`);
    else if (quality() === 'standard') bytes.replaceChildren(formatBytes(fresh.standard.length));
    else if (fresh.optimized)
      bytes.replaceChildren(
        formatBytes(Math.min(fresh.optimized.length, fresh.standard.length)),
        muted(fresh.optimized.length < fresh.standard.length ? `−${Math.round((1 - fresh.optimized.length / fresh.standard.length) * 100)}%` : 'no smaller'),
      );
    else bytes.replaceChildren(formatBytes(fresh.standard.length), muted(totalSize() < OPT_EST_MAX ? 'optimizing…' : 'optimized size shown after export'));
  }

  // ---------- Inspector ----------
  function panel() {
    const busyNow = !!controller;
    exportBtn.disabled = splitBtn.disabled = !order.length || busyNow;
    const k = kept().length;
    orderInfo.textContent = order.length ? `${plural(k, 'page')} from ${plural(sources.length, 'file')} · ${formatBytes(totalSize())}` : '';
    sigBox.hidden = !docs().some((d) => d.signed);
    const sel = selection();
    const one = sel.length === 1 ? (sel[0].deleted ? 'Deleted page' : `Page ${kept().indexOf(sel[0]) + 1}`) : '';
    selInfo.textContent = sel.length ? (one ? `${one} selected. Shift or Ctrl/Cmd+click to select more.` : `${sel.length} pages selected.`) : '';
    $('[data-act="delete"] [data-label]').textContent = sel.length && sel.every((p) => p.deleted) ? 'Restore' : 'Delete';
    const imgs = images().length;
    $('[data-img-info]').textContent = imgs ? `${plural(imgs, 'image page')} in the order. Each becomes one page.` : '';
    splitSummary();
    summary();
  }

  function splitSummary() {
    const how = new FormData(splitForm).get('split');
    rangesField.hidden = useSel.hidden = how === 'each';
    const n = kept().length;
    if (!n) return void (splitInfo.textContent = '');
    if (how === 'each') return void (splitInfo.textContent = `${plural(n, 'PDF')}, one per page, plus a ZIP of all.`);
    try {
      const groups = parseRanges(rangesInput.value, n);
      const pages = groups.flat().length;
      splitInfo.textContent = how === 'extract' ? `1 PDF with ${plural(pages, 'page')}, in the order listed.` : `${plural(groups.length, 'PDF')}, one per range${groups.length > 1 ? ', plus a ZIP of all' : ''}.`;
    } catch (err) {
      splitInfo.textContent = rangesInput.value.trim() ? errorText(err) : `Page numbers 1–${n}, as numbered in the sidebar.${how === 'extract' ? ' Listed pages are combined into one PDF.' : ' Each range becomes its own PDF.'}`;
    }
  }

  /** Selected pages as a compact range list in output numbering, e.g. "1-3, 5". */
  function selectionRanges(): string {
    const k = kept();
    const nums = selection()
      .filter((i) => !i.deleted)
      .map((p) => k.indexOf(p) + 1)
      .sort((a, b) => a - b);
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

  /** Retain PDF catalogs and page references while writing the edited page order. */
  async function build(items: Item[], signal: AbortSignal, progress?: Progress): Promise<Uint8Array> {
    const first = items[0];
    if (first && isPage(first) && items.length === first.doc.pages.length && items.every((item, index) => isPage(item) && item.doc === first.doc && item.index === index && !item.rot)) {
      const bytes = new Uint8Array(await first.doc.file.arrayBuffer());
      throwIfAborted(signal);
      return bytes;
    }
    const { degrees } = await import('@cantoo/pdf-lib');
    // Keep catalog primitives in pdf-lib's lazy chunk rather than loading them at first paint.
    const { preparePdf } = await import('./pdf-compose');
    const documents = [...new Set(items.filter(isPage).map((item) => item.doc))];
    const inputs = await Promise.all(documents.map(async (doc) => ({
      bytes: new Uint8Array(await doc.file.arrayBuffer()),
      indices: items.filter((item): item is Page => isPage(item) && item.doc === doc).map((item) => item.index),
    })));
    throwIfAborted(signal);
    const { doc: out, pages } = await preparePdf(inputs);
    const offsets = new Map<Doc, number>();
    const o = imgOptions();
    for (let i = 0; i < items.length; ) {
      throwIfAborted(signal);
      const it = items[i];
      if (!isPage(it)) {
        progress?.(`Adding ${it.file.name}`, i / items.length);
        await tick();
        const bytes = new Uint8Array(await it.file.arrayBuffer());
        let img;
        try {
          // JPEG bytes are embedded as-is (DCTDecode), so there is no quality loss.
          img = it.jpeg ? await out.embedJpg(bytes) : await out.embedPng(bytes);
        } catch {
          throw new UserError(`“${it.file.name}” could not be read. It may be damaged or use an unsupported variant.`);
        }
        const g = imageLayout({ w: img.width, h: img.height }, o);
        const pg = out.addPage([g.pw, g.ph]);
        pg.drawImage(img, { x: g.x, y: g.y, width: g.w, height: g.h });
        if (it.rot) pg.setRotation(degrees(it.rot));
        i++;
        continue;
      }
      let j = i;
      while (j + 1 < items.length && srcOf(items[j + 1]) === it.doc) j++;
      const run = items.slice(i, j + 1) as Page[];
      progress?.(`Adding pages from ${it.doc.file.name}`, i / items.length);
      await tick();
      const offset = offsets.get(it.doc) ?? 0;
      const copied = pages[documents.indexOf(it.doc)].slice(offset, offset + run.length);
      offsets.set(it.doc, offset + run.length);
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
    return out.save({ useObjectStreams: true, updateFieldAppearances: false });
  }

  /** Lossless qpdf pass (as in src/pages/pdf/compress.astro). */
  async function optimize(input: Uint8Array, signal: AbortSignal, progress: Progress): Promise<Uint8Array> {
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
    try {
      // Exit 3 = succeeded with warnings.
      const rc = qpdf.callMain(['--object-streams=generate', '--compress-streams=y', '--recompress-flate', '--compression-level=9', '/in.pdf', '/out.pdf']);
      if (rc !== 0 && rc !== 3) throw new UserError('This PDF could not be optimized. It may be damaged.');
      return fs.readFile('/out.pdf');
    } finally {
      for (const p of ['/in.pdf', '/out.pdf'])
        try {
          fs.unlink(p);
        } catch {}
    }
  }

  /** Redraw every page of `input` as one JPEG (grayscale when asked) on a page of the same size; rotation is baked in. */
  async function rasterize(input: Uint8Array, o: { dpi: number; q: number; gray: boolean }, signal: AbortSignal, progress: Progress): Promise<Uint8Array> {
    progress('Loading renderer…');
    const lib = await getPdfjs();
    const { PDFDocument } = await import('@cantoo/pdf-lib');
    // pdf.js transfers the buffer to its worker; keep the caller's (cached) bytes intact.
    const task = lib.getDocument({ data: input.slice(), worker });
    try {
      const src = await task.promise.catch(() => {
        throw new UserError('The pages could not be redrawn for Lossy or Black & white. Try Standard or Optimized.');
      });
      const out = await PDFDocument.create();
      const canvas = document.createElement('canvas');
      for (let i = 1; i <= src.numPages; i++) {
        throwIfAborted(signal);
        progress(`Redrawing page ${i} of ${src.numPages}`, (i - 1) / src.numPages);
        const pg = await src.getPage(i);
        // Viewports default to the page's /Rotate, so the image is upright and the new page needs none.
        const { width, height } = pg.getViewport({ scale: 1 });
        const s = Math.min(o.dpi / 72, Math.sqrt(MAX_CANVAS_PX / (width * height)));
        const viewport = pg.getViewport({ scale: s });
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        await pg.render({ canvas, viewport }).promise;
        pg.cleanup();
        if (o.gray) grayscale(canvas);
        const jpg = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', o.q));
        if (!jpg) throw new UserError('This browser could not encode the page images.');
        const img = await out.embedJpg(new Uint8Array(await jpg.arrayBuffer()));
        out.addPage([width, height]).drawImage(img, { x: 0, y: 0, width, height });
      }
      throwIfAborted(signal);
      progress('Saving…');
      await tick();
      return out.save({ useObjectStreams: true });
    } finally {
      void task.destroy();
    }
  }

  /** Luminance (Rec. 601) in place. */
  function grayscale(canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d')!;
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const px = data.data;
    for (let i = 0; i < px.length; i += 4) px[i] = px[i + 1] = px[i + 2] = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    ctx.putImageData(data, 0, 0);
  }

  const baseName = (name: string) => name.replace(/\.(pdf|jpe?g|png)$/i, '');
  const totalSize = () => sources.reduce((s, x) => s + x.file.size, 0);
  /** Name stem: the file's own name, or "combined" when pages come from several files. */
  const stem = () => (sources.length === 1 ? baseName(sources[0].file.name) : 'combined');
  const sigNote = () => (docs().some((d) => d.signed) ? 'The original contains digital signatures. Editing or optimizing the PDF invalidates them.' : undefined);
  /** Pages that go into any output, after checking the limits. */
  function outputPages(): Item[] {
    if (!order.length) throw new UserError('Add a PDF or image first.');
    if (docs().reduce((s, d) => s + d.file.size, 0) > MAX_TOTAL) throw new UserError('The PDFs exceed 200 MB in total.');
    const k = kept();
    if (!k.length) throw new UserError('All pages are deleted. Restore at least one page.');
    return k;
  }

  async function exportJob(signal: AbortSignal, progress: Progress): Promise<Result[]> {
    const pages = outputPages();
    const name = (nameInput.value.trim().replace(/[\\/:*?"<>|]+/g, '-') || `${stem()}.pdf`).replace(/(\.pdf)?$/i, '.pdf');
    const g = gen;
    const reuse = cache?.gen === g ? cache : undefined;
    const standard = reuse?.standard ?? (await build(pages, signal, progress));
    const sig = sigNote();
    let blob = pdfBlob(standard);
    let note = sig;
    const raster = rasterOpts();
    if (raster) {
      const bytes = await rasterize(standard, raster, signal, progress);
      blob = pdfBlob(bytes);
      note = `${raster.label}: every page is now a ${raster.dpi} dpi image; text can no longer be selected or searched.`;
      if (bytes.length > totalSize()) note += ` It is larger than the original files (${formatBytes(totalSize())}); Standard or Optimized gives a smaller file here.`;
      if (sig) note += ' ' + sig;
    } else if (quality() === 'optimized') {
      const optimized = reuse?.optimized ?? (await optimize(standard, signal, progress));
      if (g === gen) cache = { gen, standard, optimized };
      throwIfAborted(signal);
      if (optimized.length < standard.length) {
        blob = pdfBlob(optimized);
        note = `Optimized: ${Math.round((1 - optimized.length / standard.length) * 100)}% smaller than the standard export (${formatBytes(standard.length)}).`;
      } else note = 'Optimizing found nothing smaller; this is the standard export.';
      if (sig) note += ' ' + sig;
    }
    return [{ name, blob, inputSize: totalSize(), note }];
  }

  async function splitJob(signal: AbortSignal, progress: Progress): Promise<Result[]> {
    const pages = outputPages();
    const how = new FormData(splitForm).get('split');
    let groups: Item[][];
    if (how === 'each') groups = pages.map((p) => [p]);
    else {
      groups = parseRanges(rangesInput.value, pages.length).map((g) => g.map((i) => pages[i]));
      if (how === 'extract') groups = [groups.flat()];
    }
    const base = stem();
    const out: Result[] = [];
    for (const [i, g] of groups.entries()) {
      throwIfAborted(signal);
      progress(`Creating PDF ${i + 1} of ${groups.length}`, i / groups.length);
      const a = pages.indexOf(g[0]) + 1;
      const b = pages.indexOf(g[g.length - 1]) + 1;
      const name = how === 'extract' ? `${base}-extract.pdf` : `${base}-${a === b ? `p${a}` : `p${a}-${b}`}.pdf`;
      out.push({ name, blob: pdfBlob(await build(g, signal)) });
    }
    out[0].note = sigNote();
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
  }

  async function run(job: (signal: AbortSignal, progress: Progress) => Promise<Result[]>): Promise<boolean> {
    if (controller || !order.length) return false;
    controller = new AbortController();
    clearResults();
    notify('');
    showBusy('Working…', true);
    panel();
    try {
      const completed = await job(controller.signal, (text, fraction) => {
        busyText.textContent = text;
        setDial(dial, fraction);
      });
      throwIfAborted(controller.signal);
      results = completed;
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

  async function exportPdf() {
    if (!(await run(exportJob))) return;
    const r = results[0];
    downloadBlob(r.blob, r.name);
    exportInfo.textContent = `${r.name} · ${formatBytes(r.blob.size)}`;
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
    exportInfo.textContent = '';
  }

  function showResults() {
    resultsTitle.textContent = results.length === 1 ? 'Result' : `${results.length} results`;
    resultList.replaceChildren(
      ...results.map((r) => {
        const url = URL.createObjectURL(r.blob);
        publishOutput(r.blob, r.name);
        urls.push(url);
        let delta = '';
        if (r.inputSize) {
          const pct = Math.round((r.blob.size / r.inputSize - 1) * 100);
          delta = pct === 0 ? ' · same size as the originals' : pct < 0 ? ` · ${-pct}% smaller than the originals` : ` · ${pct}% larger than the originals`;
        }
        const meta = el('p', { className: 'pa-res-meta', textContent: `${formatBytes(r.blob.size)}${delta}` });
        const actions = el('div', { className: 'pa-res-actions' });
        if (r.blob.type === 'application/pdf') {
          const open = el('button', { type: 'button', className: 'btn', title: 'Add this file to the document', ariaLabel: `Open ${r.name} in the viewer` });
          open.append(icon('open'), 'Open');
          open.addEventListener('click', () => void addFiles([new File([r.blob], r.name, { type: 'application/pdf' })]));
          actions.append(open);
        }
        const link = el('a', { className: 'btn btn-primary', href: url, download: r.name, ariaLabel: `Download ${r.name}` });
        link.append(icon('download'), 'Download');
        actions.append(link);
        return el('li', {}, el('div', { className: 'pa-res-body' }, el('p', { className: 'pa-res-name', textContent: r.name }), meta, ...(r.note ? [el('p', { className: 'pa-res-note', textContent: r.note })] : [])), actions);
      }),
    );
    resultsBox.hidden = false;
    say(`${results.length === 1 ? 'Result' : `${results.length} results`} ready.`);
  }

  // ---------- Wiring ----------
  input.addEventListener('change', () => {
    void addFiles([...(input.files ?? [])]);
    input.value = '';
  });
  $('[data-open]').addEventListener('click', () => input.click());
  closeAll.addEventListener('click', () => {
    for (const s of [...sources]) closeSource(s);
    selected.clear();
    current = undefined;
    nameEdited = false;
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
  document.addEventListener('keydown', (e) => {
    const inApp = root.contains(document.activeElement) || document.activeElement === document.body;
    // Ctrl/Cmd+S exports instead of saving the web page.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 's' && inApp) {
      e.preventDefault();
      void exportPdf();
      return;
    }
    // G switches views from anywhere in the app except text fields.
    if (e.key.toLowerCase() !== 'g' || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented || !inApp) return;
    if ((e.target as Element).closest('input:not([type="radio"], [type="range"], [type="checkbox"]), textarea, select, [contenteditable]')) return;
    e.preventDefault();
    setView(isGrid() ? 'pages' : 'grid');
  });

  for (const r of viewRadios) r.addEventListener('change', () => r.checked && setView(r.value as ViewKind));
  sizeInput.addEventListener('input', () => setCardSize(Number(sizeInput.value)));
  reorderable(side, 'side');
  reorderable(grid, 'grid');
  $('[data-group]').addEventListener('click', () => {
    animate(() => {
      order.splice(0, order.length, ...sources.flatMap((s) => order.filter((p) => srcOf(p) === s)));
      changed();
    });
    say('Pages grouped by file.');
  });

  resizable($('[data-resize="left"]'), {
    key: 'pdf.left',
    min: () => 150,
    max: () => Math.max(150, Math.min(440, root.clientWidth * 0.3)),
    initial: 220,
    apply: (px) => root.style.setProperty('--pa-left', `${px}px`),
    fromPointer: (e, s) => s.size + e.clientX - s.x,
    growKey: 'ArrowRight',
    shrinkKey: 'ArrowLeft',
    container: root,
  });
  resizable($('[data-resize="right"]'), {
    key: 'pdf.right',
    min: () => 260,
    max: () => Math.max(260, Math.min(480, root.clientWidth * 0.35)),
    initial: 300,
    apply: (px) => root.style.setProperty('--pa-right', `${px}px`),
    fromPointer: (e, s) => s.size - (e.clientX - s.x),
    growKey: 'ArrowLeft',
    shrinkKey: 'ArrowRight',
    container: root,
  });
  // Bigger thumbnails / cards after the sidebar or grid grows: re-render the ones already seen, once resizing settles.
  new ResizeObserver(() => requeue('thumb')).observe(side);
  new ResizeObserver(() => requeue('card')).observe(grid);

  for (const b of root.querySelectorAll<HTMLButtonElement>('.pa-insp [data-act]')) b.addEventListener('click', () => act(b.dataset.act!));
  $('[data-zoom-in]').addEventListener('click', () => stepZoom(1));
  $('[data-zoom-out]').addEventListener('click', () => stepZoom(-1));
  zoomSel.addEventListener('change', () => setZoom(zoomSel.value === 'width' || zoomSel.value === 'page' ? zoomSel.value : Number(zoomSel.value)));
  pageInput.addEventListener('change', () => {
    const it = order[Math.max(1, Math.min(order.length, Math.round(Number(pageInput.value)) || 1)) - 1];
    if (it) select(it, 'only', true);
  });
  $('[data-msg-close]').addEventListener('click', () => notify(''));
  $('[data-results-close]').addEventListener('click', clearResults);
  busyCancel.addEventListener('click', () => controller?.abort());
  exportForm.addEventListener('submit', (e) => {
    e.preventDefault();
    void exportPdf();
  });
  exportForm.addEventListener('change', () => {
    clearResults();
    summary();
    scheduleEstimate(300);
  });
  nameInput.addEventListener('input', () => (nameEdited = nameInput.value.trim() !== ''));
  splitForm.addEventListener('submit', (e) => {
    e.preventDefault();
    void run(splitJob);
  });
  splitForm.addEventListener('input', () => {
    clearResults();
    splitSummary();
  });
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
    dirty();
    summary();
  });

  function applyMode(mode: string | null) {
    splitSection.toggleAttribute('data-highlight', mode === 'split');
    if (mode === 'compress') {
      (exportForm.elements.namedItem('quality') as RadioNodeList).value = 'optimized';
      clearResults();
      summary();
      scheduleEstimate(300);
    }
    if (mode === 'split') {
      reveal(splitSection, $('.pa-insp'));
      splitForm.querySelector<HTMLInputElement>('input:checked')!.focus({ preventScroll: true });
    }
  }
  setCardSize(cardSize);
  setView(session('pdf.view') === 'grid' ? 'grid' : 'pages');
  changed();
  applyMode(new URLSearchParams(location.search).get('mode'));
  window.addEventListener('tools:mode', (event) => applyMode((event as CustomEvent<string | null>).detail));
}
