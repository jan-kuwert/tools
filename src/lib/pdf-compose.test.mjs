// Run: node --test src/lib/pdf-compose.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRef, PDFString, StandardFonts, degrees } from '@cantoo/pdf-lib';
import { preparePdf } from './pdf-compose.ts';

const N = PDFName.of;
const D = (owner, key) => owner.lookup(N(key), PDFDict);
const A = (owner, key) => owner.lookup(N(key), PDFArray);

async function fixture(label, hidden = false) {
  const doc = await PDFDocument.create();
  doc.setTitle(label);
  const pages = [doc.addPage([300, 400]), doc.addPage([300, 400])];
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const [index, page] of pages.entries()) page.drawText(`${label} page ${index + 1}`, { x: 20, y: 350, font });
  const form = doc.getForm();
  const field = form.createTextField('answer');
  field.setText(label);
  field.addToPage(pages[0], { x: 20, y: 250, width: 150, height: 25, font });
  const last = form.createTextField('last');
  last.setText(`${label} last`);
  last.addToPage(pages[1], { x: 20, y: 250, width: 150, height: 25, font });
  form.updateFieldAppearances(font);
  const acro = D(doc.catalog, 'AcroForm');
  acro.set(N('DR'), doc.context.obj({ Font: { Shared: font.ref } }));
  field.acroField.dict.set(N('DA'), PDFString.of('/Shared 10 Tf 0 g'));
  last.acroField.dict.set(N('DA'), PDFString.of('/Shared 10 Tf 0 g'));
  // /P is optional: association through a deleted page's /Annots must suffice.
  last.acroField.getWidgets()[0].dict.delete(N('P'));
  const outline = doc.context.obj({ Type: 'Outlines', Count: 2 });
  const outlineRef = doc.context.register(outline);
  const first = doc.context.obj({ Title: PDFHexString.fromText(`${label} first`), Parent: outlineRef, Dest: [pages[0].ref, 'Fit'] });
  const second = doc.context.obj({ Title: PDFHexString.fromText(`${label} last`), Parent: outlineRef, Dest: [pages[1].ref, 'Fit'] });
  const firstRef = doc.context.register(first);
  const secondRef = doc.context.register(second);
  first.set(N('Next'), secondRef);
  second.set(N('Prev'), firstRef);
  outline.set(N('First'), firstRef);
  outline.set(N('Last'), secondRef);
  doc.catalog.set(N('Outlines'), outlineRef);
  doc.catalog.set(N('Names'), doc.context.obj({ Dests: { Names: [PDFHexString.fromText('first'), [pages[0].ref, 'Fit'], PDFHexString.fromText('last'), [pages[1].ref, 'Fit']] } }));
  await doc.attach(new TextEncoder().encode(label), `${label}.txt`);
  const link = doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [20, 20, 150, 50], A: { S: 'GoTo', D: PDFHexString.fromText('first') } }));
  const removedLink = doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [20, 60, 150, 90], A: { S: 'GoTo', D: PDFHexString.fromText('last') } }));
  pages[0].node.addAnnot(link);
  pages[0].node.addAnnot(removedLink);
  const layer = doc.context.register(doc.context.obj({ Type: 'OCG', Name: PDFHexString.fromText(`${label} layer`) }));
  doc.catalog.set(N('OCProperties'), doc.context.obj({ OCGs: [layer], D: { BaseState: hidden ? 'OFF' : 'ON', Order: [layer] } }));
  pages[0].node.Resources().set(N('Properties'), doc.context.obj({ Layer: layer }));
  pages[0].node.addContentStream(doc.context.register(doc.context.flateStream('/OC /Layer BDC\n0 0 1 rg 20 100 50 50 re f\nEMC')));
  doc.catalog.set(N('OpenAction'), doc.context.obj([pages[0].ref, 'Fit']));
  doc.catalog.set(N('ViewerPreferences'), doc.context.obj({ DisplayDocTitle: true }));
  doc.catalog.set(N('CustomPageRef'), pages[0].ref);
  pages[0].node.lookup(N('Parent'), PDFDict).set(N('Resources'), pages[0].node.Resources());
  pages[0].node.delete(N('Resources'));
  const refs = pages.map((page) => page.ref.toString());
  return { bytes: await doc.save({ updateFieldAppearances: false }), refs };
}

async function composed(inputs, order, rotate = false) {
  const { doc, pages } = await preparePdf(inputs);
  for (const [source, index] of order) doc.addPage(pages[source][index]);
  if (rotate) doc.getPage(0).setRotation(degrees(90));
  return PDFDocument.load(await doc.save({ updateFieldAppearances: false }), { updateMetadata: false });
}

function assertPageReferences(doc) {
  const active = new Set(doc.getPages().map((page) => page.ref));
  function visit(object, seen = new Set()) {
    const value = doc.context.lookup(object);
    if (object instanceof PDFRef) assert.ok(value, `dangling reference ${object}`);
    if (!value || seen.has(value)) return;
    seen.add(value);
    if (value instanceof PDFDict) {
      if (value.get(N('Type')) === N('Page')) assert.ok(active.has(object), `detached page ${object}`);
      for (const [, child] of value.entries()) visit(child, seen);
    } else if (value instanceof PDFArray) for (const child of value.asArray()) visit(child, seen);
  }
  visit(doc.context.trailerInfo.Root);
}

function outlines(doc) {
  const result = [];
  let node = D(D(doc.catalog, 'Outlines'), 'First');
  while (node) {
    result.push(node);
    node = node.lookupMaybe(N('Next'), PDFDict);
  }
  return result;
}

test('reordering/rotation retains original page refs, bookmarks, named links, fields, attachments and layer defaults', async () => {
  const source = await fixture('primary', true);
  const doc = await composed([{ bytes: source.bytes, indices: [1, 0] }], [[0, 0], [0, 1]], true);
  assert.deepEqual(doc.getPages().map((page) => page.ref.toString()), source.refs.toReversed());
  assert.equal(doc.getPage(0).getRotation().angle, 90);
  assert.equal(doc.getTitle(), 'primary');
  assert.equal(doc.catalog.get(N('CustomPageRef')).toString(), source.refs[0]);
  assert.equal(A(outlines(doc)[0], 'Dest').get(0).toString(), source.refs[0]);
  assert.equal(A(doc.catalog, 'OpenAction').get(0).toString(), source.refs[0]);
  assert.equal(doc.getForm().getTextField('answer').getText(), 'primary');
  assert.equal(doc.getForm().getTextField('last').getText(), 'primary last');
  assert.deepEqual(doc.getOptionalContentGroups().map(({ name, visible }) => [name, visible]), [['primary layer', false]]);
  assert.equal(D(doc.getPage(1).node.Resources(), 'Properties').get(N('Layer')), doc.getOptionalContentGroups()[0].ref);
  assert.equal(A(D(D(doc.catalog, 'Names'), 'EmbeddedFiles'), 'Names').size(), 2);
  assertPageReferences(doc);
});

test('deletion prunes removed destinations, actions and widgets, including widgets without /P', async () => {
  const source = await fixture('partial');
  const doc = await composed([{ bytes: source.bytes, indices: [0] }], [[0, 0]]);
  assert.deepEqual(doc.getForm().getFields().map((field) => field.getName()), ['answer']);
  assert.equal(outlines(doc)[1].has(N('Dest')), false);
  const names = A(D(D(doc.catalog, 'Names'), 'Dests'), 'Names');
  assert.equal(names.size(), 2);
  assert.equal(names.lookup(0).decodeText(), 'first');
  const links = A(doc.getPage(0).node, 'Annots').asArray().map((ref) => doc.context.lookup(ref, PDFDict)).filter((entry) => entry.get(N('Subtype')) === N('Link'));
  assert.ok(links[0].has(N('A')));
  assert.equal(links[1].has(N('A')), false);
  assertPageReferences(doc);
});

test('merging registers both forms, bookmarks, names and layers with shared page mappings', async () => {
  const a = await fixture('primary', true);
  const b = await fixture('donor');
  const doc = await composed([{ bytes: a.bytes, indices: [0] }, { bytes: b.bytes, indices: [0] }], [[1, 0], [0, 0]]);
  assert.equal(doc.getTitle(), 'primary');
  assert.equal(doc.getForm().getTextField('answer').getText(), 'primary');
  assert.equal(doc.getForm().getTextField('answer (2)').getText(), 'donor');
  const bookmarks = outlines(doc);
  assert.equal(bookmarks.length, 4);
  assert.equal(A(bookmarks[0], 'Dest').get(0), doc.getPage(1).ref);
  assert.equal(A(bookmarks[2], 'Dest').get(0), doc.getPage(0).ref);
  const destinations = A(D(D(doc.catalog, 'Names'), 'Dests'), 'Names');
  assert.equal(destinations.size(), 4);
  assert.equal(destinations.lookup(2).decodeText(), 'first (2)');
  assert.equal(destinations.lookup(3, PDFArray).get(0), doc.getPage(0).ref);
  const donorLink = A(doc.getPage(0).node, 'Annots').asArray().map((ref) => doc.context.lookup(ref, PDFDict)).find((entry) => entry.get(N('Subtype')) === N('Link'));
  assert.equal(D(donorLink, 'A').lookup(N('D')).decodeText(), 'first (2)');
  assert.deepEqual(doc.getOptionalContentGroups().map(({ name, visible }) => [name, visible]), [['primary layer', false], ['donor layer', true]]);
  assert.equal(A(D(D(doc.catalog, 'Names'), 'EmbeddedFiles'), 'Names').size(), 4);
  const donorField = doc.getForm().getTextField('answer (2)').acroField.dict;
  const fontName = /\/(\S+)\s+10\s+Tf/.exec(donorField.lookup(N('DA')).decodeText())[1];
  assert.ok(D(D(D(doc.catalog, 'AcroForm'), 'DR'), 'Font').has(N(fontName)));
  assert.equal(fontName, 'Shared_2');
  assert.equal(doc.getForm().getTextField('answer (2)').acroField.getWidgets()[0].P(), doc.getPage(0).ref);
  assertPageReferences(doc);
});

test('repeated extraction ranges use distinct page and registered widget refs', async () => {
  const source = await fixture('repeat');
  const doc = await composed([{ bytes: source.bytes, indices: [0, 0] }], [[0, 0], [0, 1]]);
  assert.notEqual(doc.getPage(0).ref, doc.getPage(1).ref);
  assert.equal(doc.getForm().getFields().length, 2);
  assert.equal(doc.getForm().getTextField('answer').getText(), 'repeat');
  assert.equal(doc.getForm().getTextField('answer (2)').getText(), 'repeat');
  assertPageReferences(doc);
});

test('legacy destination dictionaries and name trees share a collision-free destination namespace', async () => {
  const primary = await fixture('modern');
  const legacy = await fixture('legacy');
  const donor = await PDFDocument.load(legacy.bytes);
  const tree = D(D(donor.catalog, 'Names'), 'Dests');
  const entries = A(tree, 'Names');
  donor.catalog.set(N('Dests'), donor.context.obj({ first: entries.get(1), last: entries.get(3) }));
  D(donor.catalog, 'Names').delete(N('Dests'));
  const links = A(donor.getPage(0).node, 'Annots').asArray().map((ref) => donor.context.lookup(ref, PDFDict)).filter((entry) => entry.get(N('Subtype')) === N('Link'));
  D(links[0], 'A').set(N('D'), N('first'));
  D(links[1], 'A').set(N('D'), N('last'));
  const bytes = await donor.save({ updateFieldAppearances: false });
  const doc = await composed([{ bytes: primary.bytes, indices: [0] }, { bytes, indices: [0] }], [[0, 0], [1, 0]]);
  assert.equal(D(doc.catalog, 'Dests').lookup(N('first (2)'), PDFArray).get(0), doc.getPage(1).ref);
  const mergedLink = A(doc.getPage(1).node, 'Annots').asArray().map((ref) => doc.context.lookup(ref, PDFDict)).find((entry) => entry.get(N('Subtype')) === N('Link'));
  assert.equal(D(mergedLink, 'A').get(N('D')), N('first (2)'));
  assertPageReferences(doc);
});

const app = ts.createSourceFile('pdf-app.ts', readFileSync(new URL('./pdf-app.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
function appFunctionSource(name) {
  let found;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node;
    ts.forEachChild(node, visit);
  }
  visit(app);
  assert.ok(found, `missing app function ${name}`);
  return ts.transpileModule(found.getText(app), { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;
}

test('unchanged exports pass original bytes to the lossless optimizer without rebuilding the catalog', async () => {
  const source = await fixture('unchanged');
  const doc = { file: new Blob([source.bytes]), pages: [] };
  const items = [0, 1].map((index) => ({ doc, index, rot: 0 }));
  doc.pages = items;
  const build = new Function('isPage', 'throwIfAborted', `${appFunctionSource('build')}; return build;`)((item) => 'doc' in item, (signal) => signal.throwIfAborted());
  assert.deepEqual(await build(items, new AbortController().signal), source.bytes);
});

test('cancellation during the final save never publishes results or starts the automatic download', async () => {
  let controller;
  let published = false;
  const notifications = [];
  const env = {
    AbortController: class extends AbortController { constructor() { super(); controller = this; } },
    order: [{}], clearResults() {}, notify(message) { notifications.push(message); }, showBusy() {}, panel() {}, busyText: {}, setDial() {}, dial: {},
    showResults() { published = true; }, throwIfAborted(signal) { signal.throwIfAborted(); }, UserError: Error, errorText: String, busy: {},
  };
  const harness = new Function(...Object.keys(env), `let controller; let results = []; ${appFunctionSource('run')}; return { run, results: () => results };`)(...Object.values(env));
  let finishSave;
  const saving = new Promise((resolve) => { finishSave = resolve; });
  const result = harness.run(async () => { await saving; return [{ name: 'cancelled.pdf', blob: new Blob() }]; });
  controller.abort();
  finishSave();
  assert.equal(await result, false); // exportPdf downloads only when run returns true.
  assert.deepEqual(harness.results(), []);
  assert.equal(published, false);
  assert.deepEqual(notifications, ['', 'Cancelled.']);
  const completed = [{ name: 'completed.pdf', blob: new Blob() }];
  assert.equal(await harness.run(async () => completed), true);
  assert.equal(published, true);
  assert.equal(harness.results(), completed);
});

test('live hub modes update quality/chrome and reveal Split without resetting loaded documents', () => {
  const quality = { value: 'standard' };
  const section = { highlighted: false, toggleAttribute(_key, value) { this.highlighted = value; } };
  let summaries = 0;
  let estimates = 0;
  let revealed = 0;
  let focused = 0;
  const env = {
    splitSection: section, exportForm: { elements: { namedItem: () => quality } }, clearResults() {}, summary() { summaries++; }, scheduleEstimate() { estimates++; },
    reveal() { revealed++; }, $() {}, splitForm: { querySelector: () => ({ focus() { focused++; } }) },
  };
  const applyMode = new Function(...Object.keys(env), `${appFunctionSource('applyMode')}; return applyMode;`)(...Object.values(env));
  applyMode('compress');
  assert.equal(quality.value, 'optimized');
  assert.equal(summaries, 1);
  assert.equal(estimates, 1);
  applyMode('split');
  assert.equal(section.highlighted, true);
  assert.equal(revealed, 1);
  assert.equal(focused, 1);
  applyMode(null);
  assert.equal(section.highlighted, false);
  assert.equal(quality.value, 'optimized');
});
