// Run: node --test src/lib/text-ui.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = ts.createSourceFile('text-app.ts', readFileSync(new URL('./text-app.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const nodes = [];
const visit = (node) => { nodes.push(node); ts.forEachChild(node, visit); };
visit(source);
const named = (name) => nodes.find((node) => (ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) && node.name?.getText(source) === name);
const javascript = (text) => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;

function fixture() {
  const timers = new Map();
  const frames = [];
  const rendered = [];
  const shown = [];
  const focused = [];
  let timer = 0;
  const items = [1, 2].map((id) => ({ id, name: `${id}.md`, type: 'markdown', text: `old ${id}`, edited: true }));
  const panes = items.map((item) => ({
    el: { hidden: false }, ta: { value: `edited ${item.id}` }, open: [item.id], active: item.id, shown: item.id,
    code: {}, gutter: {}, curline: {}, hex: {}, tabsEl: {}, hlCode: {}, editorEl: {},
    dirty: true, lineCount: 1, synTimer: 0, mdTimer: 0,
    mdEl: { hidden: false, scrollTop: 12, replaceChildren(value) { this.value = value; } },
  }));
  const context = vm.createContext({
    Blob, Promise, items, panes, pane: panes[0], leader: panes[0], ...panes[0], DIFF: -1, MIME_OF: {},
    md: { renderMarkdown: (text) => text }, diffSrc: undefined, defaultType: undefined, mdPlaceholder: undefined, untitled: 0,
    window: { setTimeout(fn) { timers.set(++timer, fn); return timer; }, addEventListener(name, fn) { context[name] = fn; } },
    clearTimeout: (id) => timers.delete(id), requestAnimationFrame: (fn) => frames.push(fn), setTimeout: (fn) => fn(),
    say() {}, saveView: () => context.sync(),
    showActive: () => shown.push({ pane: context.pane, active: context.active }),
    activatePane(p) { context.usePane(p); context.leader = p; },
    renderDiff: () => rendered.push({ pane: context.pane, active: context.active, sources: context.diffSrc }),
    diffBody: { focus: () => focused.push(context.pane) },
    compareSec: { open: false }, setTools() {}, uniqueName: (name) => name,
    addItem(props) { const item = { ...props, id: items.length + 1 }; items.push(item); return item; },
    openItem(id) { context.sync(); context.active = id; context.shown = id; context.ta.value = context.byId(id).text; },
    downloadBlob(blob, name) { context.downloaded = { blob, name }; },
  });
  panes.forEach((p) => { p.el.hasAttribute = () => context.leader === p; });
  for (const name of ['byId', 'cur', 'curText', 'sync', 'blobOf', 'leads', 'usePane', 'withPane', 'scheduleMd', 'compare', 'applyMode']) {
    const node = named(name);
    const text = ts.isFunctionDeclaration(node) ? node.getText(source) : `var ${node.getText(source)};`;
    // Control only the module-loading boundary; execute the production scheduling logic unchanged.
    vm.runInContext(javascript(text.replace("import('./markdown')", 'loadMarkdown()')), context);
  }
  const download = nodes.find((node) => ts.isCallExpression(node) && node.expression.getText(source) === 'btn' && node.arguments[0]?.getText(source) === "'download'");
  context.it = items[1];
  vm.runInContext(javascript(`var explorerDownload = ${download.arguments[2].getText(source)};`), context);
  const modeListener = nodes.find((node) => ts.isCallExpression(node) && node.expression.getText(source) === 'window.addEventListener' && node.arguments[0]?.getText(source) === "'tools:mode'");
  vm.runInContext(javascript(modeListener.getText(source)), context);
  return {
    context, items, panes, rendered, shown, focused,
    fire(id) { const fn = timers.get(id); timers.delete(id); return fn(); },
    paint() { frames.splice(0).forEach((fn) => fn()); },
  };
}

test('Explorer downloads synchronize both pane buffers before constructing a blob', async () => {
  const { context, items, panes } = fixture();
  context.explorerDownload();
  assert.equal(await context.downloaded.blob.text(), 'edited 2');
  assert.equal(items[0].text, 'edited 1');
  assert.equal(items[1].text, 'edited 2');
  assert.equal(context.pane, panes[0]);
});

test('Markdown timers render their own panes without cancelling each other', async () => {
  const { context, panes, fire } = fixture();
  context.scheduleMd();
  context.withPane(panes[1], () => context.scheduleMd());
  await fire(panes[1].mdTimer);
  await fire(panes[0].mdTimer);
  assert.equal(panes[0].mdEl.value, 'edited 1');
  assert.equal(panes[1].mdEl.value, 'edited 2');
  assert.equal(panes[1].mdEl.scrollTop, 12);
  assert.equal(context.pane, panes[0]);
});

test('Markdown imports cannot paint an obsolete document or timer', async () => {
  const { context, items, panes, fire } = fixture();
  const loading = Promise.withResolvers();
  context.md = undefined;
  context.loadMarkdown = () => loading.promise;
  context.scheduleMd();
  const old = fire(panes[0].mdTimer);
  context.scheduleMd();
  loading.resolve({ renderMarkdown: (text) => text });
  await old;
  assert.equal(panes[0].mdEl.value, undefined);
  const currentTimer = panes[0].mdTimer;
  context.active = items[1].id;
  await fire(currentTimer);
  assert.equal(panes[0].mdEl.value, undefined);
});

test('Markdown imports cannot paint a document switched or hidden while loading', async () => {
  for (const hide of [false, true]) {
    const { context, panes, fire } = fixture();
    const loading = Promise.withResolvers();
    context.md = undefined;
    context.loadMarkdown = () => loading.promise;
    context.scheduleMd();
    const pending = fire(panes[0].mdTimer);
    if (hide) panes[0].mdEl.hidden = true;
    else context.active = 2;
    loading.resolve({ renderMarkdown: (text) => text });
    await pending;
    assert.equal(panes[0].mdEl.value, undefined);
  }
});

test('Compare finishes in the first pane without stealing navigation or focus', async () => {
  const { context, panes, rendered, shown, focused, paint } = fixture();
  const pending = context.compare({ id: 1 }, { id: 2 });
  assert.equal(shown[0].active, -1);
  context.activatePane(panes[1]);
  paint();
  await pending;
  assert.equal(rendered[0].pane, panes[0]);
  assert.equal(context.pane, panes[1]);
  assert.equal(context.active, 2);
  assert.equal(shown.length, 1);
  assert.equal(focused.length, 0);
});

test('Compare respects another tab and a comparison closed before paint', async () => {
  const { context, rendered, focused, paint } = fixture();
  const pending = context.compare({ id: 1 }, { id: 2 });
  context.active = 1;
  paint();
  await pending;
  assert.equal(context.active, 1);
  assert.equal(focused.length, 0);
  assert.equal(rendered.length, 1);
  const closed = context.compare({ id: 1 }, { id: 2 });
  context.open.splice(context.open.indexOf(-1), 1);
  context.active = 1;
  paint();
  await closed;
  assert.equal(rendered.length, 1);
});

test('Only the latest requested comparison renders', async () => {
  const { context, rendered, focused, paint } = fixture();
  const old = context.compare({ id: 1 }, { id: 2 });
  const latest = context.compare({ id: 2 }, { id: 1 });
  paint();
  await Promise.all([old, latest]);
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0].sources.a.id, 2);
  assert.equal(focused.length, 1);
});

test('Hub mode events reuse Markdown documents and preserve edits and chosen views', () => {
  const { context, items } = fixture();
  items[0].mdView = 'edit';
  context['tools:mode']({ detail: 'markdown' });
  context['tools:mode']({ detail: 'json' });
  assert.equal(context.defaultType, 'json');
  context['tools:mode']({ detail: null });
  assert.equal(context.defaultType, undefined);
  context['tools:mode']({ detail: 'markdown' });
  assert.equal(items.length, 2);
  assert.equal(context.active, 1);
  assert.equal(items[0].text, 'edited 1');
  assert.equal(items[0].mdView, 'edit');
  items[0].type = 'plaintext';
  context['tools:mode']({ detail: 'markdown' });
  assert.equal(context.active, 2);
  assert.equal(items.length, 2);
});

test('Markdown mode creates only one placeholder when none exists', () => {
  const { context, items } = fixture();
  items.forEach((item) => { item.type = 'plaintext'; });
  // addItem normally infers the Markdown extension.
  const addItem = context.addItem;
  context.addItem = (props) => addItem({ ...props, type: 'markdown' });
  context.applyMode('markdown');
  const placeholder = context.mdPlaceholder;
  context.applyMode(null);
  context.applyMode('markdown');
  assert.equal(items.length, 3);
  assert.equal(context.active, placeholder);
  assert.equal(context.byId(placeholder).mdView, 'split');
});
