import { PDFArray, PDFBool, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNull, PDFNumber, PDFObjectCopier, PDFPage, PDFPageLeaf, PDFRef, PDFStream, PDFString, type PDFObject } from '@cantoo/pdf-lib';

const name = PDFName.of;
const text = (value: PDFObject | undefined) => value instanceof PDFString || value instanceof PDFHexString || value instanceof PDFName ? value.decodeText() : undefined;
const dict = (owner: PDFDict, key: string) => owner.lookupMaybe(name(key), PDFDict);
const array = (owner: PDFDict, key: string) => owner.lookupMaybe(name(key), PDFArray);

function nameEntries(tree: PDFDict, seen = new Set<PDFDict>()): [string, PDFObject][] {
  if (seen.has(tree)) return [];
  seen.add(tree);
  const entries: [string, PDFObject][] = [];
  const names = array(tree, 'Names');
  if (names) for (let i = 0; i + 1 < names.size(); i += 2) {
    const key = text(names.lookup(i));
    if (key !== undefined) entries.push([key, names.get(i + 1)]);
  }
  const kids = array(tree, 'Kids');
  if (kids) for (let i = 0; i < kids.size(); i++) entries.push(...nameEntries(kids.lookup(i, PDFDict), seen));
  return entries;
}

function walk(doc: PDFDocument, visit: (object: PDFDict | PDFArray) => void) {
  const seen = new Set<PDFObject>();
  function next(object: PDFObject) {
    if (seen.has(object)) return;
    seen.add(object);
    if (object instanceof PDFStream) next(object.dict);
    else if (object instanceof PDFDict || object instanceof PDFArray) {
      visit(object);
      const values = object instanceof PDFDict ? object.values() : object.asArray();
      for (const value of values) if (!(value instanceof PDFRef)) next(value);
    }
  }
  for (const [, object] of doc.context.enumerateIndirectObjects()) next(object);
}

function prunePages(doc: PDFDocument, omitted: PDFPage[]) {
  if (!omitted.length) return;
  const removed = new Set(omitted.map((page) => page.ref));
  const removedWidgets = new Set<PDFObject>();
  for (const page of omitted) {
    const annotations = array(page.node, 'Annots');
    if (annotations) for (const annotation of annotations.asArray()) removedWidgets.add(annotation);
  }
  const missingNames = new Set<string>();
  const badDestination = (value: PDFObject | undefined): boolean => {
    const resolved = doc.context.lookup(value);
    if (resolved instanceof PDFArray) return removed.has(resolved.get(0) as PDFRef);
    if (resolved instanceof PDFDict) return badDestination(resolved.get(name('D')));
    const key = text(resolved);
    return key !== undefined && missingNames.has(key);
  };
  const dests = dict(doc.catalog, 'Dests');
  if (dests) for (const [key, value] of dests.entries()) if (badDestination(value)) {
    missingNames.add(key.decodeText());
    dests.delete(key);
  }
  const names = dict(doc.catalog, 'Names');
  const tree = names && dict(names, 'Dests');
  if (tree) {
    const entries = nameEntries(tree).filter(([key, value]) => {
      if (!badDestination(value)) return true;
      missingNames.add(key);
      return false;
    });
    tree.delete(name('Kids'));
    tree.delete(name('Limits'));
    tree.set(name('Names'), doc.context.obj(entries.flatMap(([key, value]) => [PDFHexString.fromText(key), value])));
  }
  const acro = dict(doc.catalog, 'AcroForm');
  const retainedFields = new Set<PDFObject>();
  function pruneFields(fields: PDFArray, seen = new Set<PDFDict>()) {
    for (let i = fields.size() - 1; i >= 0; i--) {
      const field = fields.lookup(i, PDFDict);
      if (seen.has(field)) continue;
      seen.add(field);
      const kids = array(field, 'Kids');
      if (kids) pruneFields(kids, seen);
      if (removedWidgets.has(fields.get(i)) || removed.has(field.get(name('P')) as PDFRef) || (kids && !kids.size())) fields.remove(i);
      else retainedFields.add(fields.get(i));
    }
  }
  const fields = acro && array(acro, 'Fields');
  if (fields) pruneFields(fields);
  const calculationOrder = acro && array(acro, 'CO');
  if (calculationOrder) for (let i = calculationOrder.size() - 1; i >= 0; i--) if (!retainedFields.has(calculationOrder.get(i))) calculationOrder.remove(i);
  walk(doc, (object) => {
    if (object instanceof PDFDict) {
      if (badDestination(object.get(name('Dest')))) object.delete(name('Dest'));
      const action = dict(object, 'A');
      if (action?.get(name('S')) === name('GoTo') && badDestination(action.get(name('D')))) object.delete(name('A'));
      const open = object.get(name('OpenAction'));
      const openAction = doc.context.lookup(open);
      if ((openAction instanceof PDFArray && badDestination(open)) || (openAction instanceof PDFDict && openAction.get(name('S')) === name('GoTo') && badDestination(openAction.get(name('D'))))) object.delete(name('OpenAction'));
      for (const [key, value] of object.entries()) if (removed.has(value as PDFRef)) object.delete(key);
    } else for (let i = 0; i < object.size(); i++) if (removed.has(object.get(i) as PDFRef)) object.set(i, PDFNull);
  });
}

function appendArray(out: PDFDict, incoming: PDFDict, key: string) {
  const extra = array(incoming, key);
  if (!extra) return;
  const current = array(out, key);
  if (current) for (const value of extra.asArray()) current.push(value);
  else out.set(name(key), extra);
}

function mergeForms(out: PDFDocument, incoming: PDFDict) {
  const source = dict(incoming, 'AcroForm');
  if (!source) return;
  const target = dict(out.catalog, 'AcroForm');
  if (!target) { out.catalog.set(name('AcroForm'), source); return; }
  const sourceFields = array(source, 'Fields');
  const targetFields = array(target, 'Fields');
  const used = new Set(targetFields?.asArray().map((value) => text(out.context.lookup(value, PDFDict).get(name('T')))));
  if (sourceFields) for (const value of sourceFields.asArray()) {
    const field = out.context.lookup(value, PDFDict);
    const original = text(field.get(name('T')));
    if (original !== undefined) {
      let unique = original;
      for (let n = 2; used.has(unique); n++) unique = `${original} (${n})`;
      if (unique !== original) field.set(name('T'), PDFHexString.fromText(unique));
      used.add(unique);
    }
    for (const key of ['DA', 'Q']) if (!field.has(name(key)) && source.has(name(key))) field.set(name(key), source.get(name(key))!);
  }
  const sourceResources = dict(source, 'DR');
  if (sourceResources) {
    let targetResources = dict(target, 'DR');
    if (!targetResources) { targetResources = PDFDict.withContext(out.context); target.set(name('DR'), targetResources); }
    const replacements = new Map<string, string>();
    for (const [kind, value] of sourceResources.entries()) {
      const resources = out.context.lookup(value);
      const existing = out.context.lookup(targetResources.get(kind));
      if (!(resources instanceof PDFDict) || !(existing instanceof PDFDict)) { targetResources.set(kind, value); continue; }
      for (const [key, resource] of resources.entries()) {
        let unique = key;
        for (let n = 2; existing.has(unique); n++) unique = name(`${key.decodeText()}_${n}`);
        existing.set(unique, resource);
        if (unique !== key) replacements.set(key.toString(), unique.toString());
      }
    }
    const visited = new Set<PDFDict>();
    function appearances(field: PDFDict) {
      if (visited.has(field)) return;
      visited.add(field);
      const da = text(field.get(name('DA')));
      if (da !== undefined) field.set(name('DA'), PDFString.of(da.replace(/\/[^\s()<>\[\]{}/%]+/g, (token) => replacements.get(token) ?? token)));
      const kids = array(field, 'Kids');
      if (kids) for (const value of kids.asArray()) appearances(out.context.lookup(value, PDFDict));
    }
    if (sourceFields) for (const value of sourceFields.asArray()) appearances(out.context.lookup(value, PDFDict));
  }
  appendArray(target, source, 'Fields');
  appendArray(target, source, 'CO');
  if (source.get(name('NeedAppearances')) === PDFBool.True) target.set(name('NeedAppearances'), PDFBool.True);
  const flags = (target.lookupMaybe(name('SigFlags'), PDFNumber)?.asNumber() ?? 0) | (source.lookupMaybe(name('SigFlags'), PDFNumber)?.asNumber() ?? 0);
  if (flags) target.set(name('SigFlags'), PDFNumber.of(flags));
  if (!target.has(name('XFA')) && source.has(name('XFA'))) target.set(name('XFA'), source.get(name('XFA'))!);
}

function mergeNames(out: PDFDocument, incoming: PDFDict, importedPages: PDFPage[]) {
  const sourceNames = dict(incoming, 'Names');
  const sourceDests = dict(incoming, 'Dests');
  let targetNames = dict(out.catalog, 'Names');
  if (sourceNames && !targetNames) { targetNames = PDFDict.withContext(out.context); out.catalog.set(name('Names'), targetNames); }
  const renamedDests = new Map<string, string>();
  const existingDests = targetNames && dict(targetNames, 'Dests');
  const reservedDests = new Set([
    ...(dict(out.catalog, 'Dests')?.keys().map((key) => key.decodeText()) ?? []),
    ...(existingDests ? nameEntries(existingDests).map(([key]) => key) : []),
  ]);
  if (sourceNames) for (const [kind, value] of sourceNames.entries()) {
    const sourceTree = out.context.lookup(value, PDFDict);
    const existingTree = dict(targetNames!, kind.decodeText());
    const entries = new Map(existingTree ? nameEntries(existingTree) : []);
    for (const [original, entry] of nameEntries(sourceTree)) {
      let unique = original;
      for (let n = 2; entries.has(unique) || (kind === name('Dests') && reservedDests.has(unique)); n++) unique = `${original} (${n})`;
      entries.set(unique, entry);
      if (kind === name('Dests')) {
        reservedDests.add(unique);
        if (unique !== original) renamedDests.set(original, unique);
      }
    }
    targetNames!.set(kind, out.context.obj({ Names: [...entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).flatMap(([key, entry]) => [PDFHexString.fromText(key), entry]) }));
  }
  if (sourceDests) {
    let targetDests = dict(out.catalog, 'Dests');
    if (!targetDests) { targetDests = PDFDict.withContext(out.context); out.catalog.set(name('Dests'), targetDests); }
    for (const [key, value] of sourceDests.entries()) {
      let unique = key;
      for (let n = 2; targetDests.has(unique) || reservedDests.has(unique.decodeText()); n++) unique = name(`${key.decodeText()} (${n})`);
      targetDests.set(unique, value);
      reservedDests.add(unique.decodeText());
      if (unique !== key) renamedDests.set(key.decodeText(), unique.decodeText());
    }
  }
  if (!renamedDests.size) return;
  const visited = new Set<PDFObject>();
  function rewrite(value: PDFObject) {
    const object = out.context.lookup(value);
    if (!object || visited.has(object)) return;
    visited.add(object);
    if (object instanceof PDFDict) {
      for (const key of ['Dest', ...(object.get(name('S')) === name('GoTo') ? ['D'] : [])]) {
        const original = object.get(name(key));
        const renamed = renamedDests.get(text(original) ?? '');
        if (renamed) object.set(name(key), original instanceof PDFName ? name(renamed) : PDFHexString.fromText(renamed));
      }
      for (const [key, child] of object.entries()) if (key !== name('Parent') && key !== name('P')) rewrite(child);
    } else if (object instanceof PDFArray) for (const child of object.asArray()) rewrite(child);
  }
  rewrite(incoming);
  for (const page of importedPages) rewrite(page.node);
}

function mergeOutlines(out: PDFDocument, incoming: PDFDict) {
  const source = dict(incoming, 'Outlines');
  if (!source) return;
  const target = dict(out.catalog, 'Outlines');
  if (!target) { out.catalog.set(name('Outlines'), incoming.get(name('Outlines'))!); return; }
  const targetRef = out.catalog.get(name('Outlines')) instanceof PDFRef ? out.catalog.get(name('Outlines')) as PDFRef : out.context.register(target);
  out.catalog.set(name('Outlines'), targetRef);
  const first = source.get(name('First'));
  if (!first) return;
  const previous = dict(target, 'Last');
  const firstNode = out.context.lookup(first, PDFDict);
  if (previous) { previous.set(name('Next'), first); firstNode.set(name('Prev'), target.get(name('Last'))!); }
  else target.set(name('First'), first);
  const seen = new Set<PDFDict>();
  let node: PDFDict | undefined = firstNode;
  while (node && !seen.has(node)) { seen.add(node); node.set(name('Parent'), targetRef); node = dict(node, 'Next'); }
  if (source.has(name('Last'))) target.set(name('Last'), source.get(name('Last'))!);
  const count = (target.lookupMaybe(name('Count'), PDFNumber)?.asNumber() ?? 0) + (source.lookupMaybe(name('Count'), PDFNumber)?.asNumber() ?? 0);
  target.set(name('Count'), PDFNumber.of(count));
}

function mergeLayers(out: PDFDocument, incoming: PDFDict) {
  const source = dict(incoming, 'OCProperties');
  if (!source) return;
  const target = dict(out.catalog, 'OCProperties');
  if (!target) { out.catalog.set(name('OCProperties'), source); return; }
  const config = dict(source, 'D');
  let targetConfig = dict(target, 'D');
  if (!targetConfig) { targetConfig = PDFDict.withContext(out.context); target.set(name('D'), targetConfig); }
  const groups = array(source, 'OCGs');
  const off = new Set(config && array(config, 'OFF')?.asArray());
  const on = new Set(config && array(config, 'ON')?.asArray());
  const defaultOff = config?.get(name('BaseState')) === name('OFF');
  if (groups) for (const group of groups.asArray()) {
    const key = off.has(group) || (defaultOff && !on.has(group)) ? 'OFF' : 'ON';
    let list = array(targetConfig, key);
    if (!list) { list = out.context.obj([]); targetConfig.set(name(key), list); }
    list.push(group);
  }
  if (config) for (const key of ['Order', 'RBGroups', 'Locked', 'AS']) appendArray(targetConfig, config, key);
  appendArray(target, source, 'OCGs');
  appendArray(target, source, 'Configs');
}

// ---------- Page labels ----------

/** Each prepared page's visible label in its source document (e.g. "iv", "A-3"), keyed by its node in the output. */
const labels = new WeakMap<PDFDict, string>();

const roman = (n: number) => {
  let s = '';
  for (const [v, r] of [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']] as const) for (; n >= v; n -= v) s += r;
  return s;
};
/** Labels of a document's pages from its /PageLabels number tree, or undefined if it has none. */
function pageLabels(doc: PDFDocument, count: number): string[] | undefined {
  const tree = dict(doc.catalog, 'PageLabels');
  if (!tree) return;
  const ranges: [number, PDFDict][] = [];
  const visit = (node: PDFDict, seen: Set<PDFDict>) => {
    if (seen.has(node)) return;
    seen.add(node);
    const nums = array(node, 'Nums');
    if (nums) for (let i = 0; i + 1 < nums.size(); i += 2) {
      const key = nums.lookup(i);
      const value = nums.lookup(i + 1);
      if (key instanceof PDFNumber && value instanceof PDFDict) ranges.push([key.asNumber(), value]);
    }
    const kids = array(node, 'Kids');
    if (kids) for (let i = 0; i < kids.size(); i++) visit(kids.lookup(i, PDFDict), seen);
  };
  visit(tree, new Set());
  ranges.sort((a, b) => a[0] - b[0]);
  return Array.from({ length: count }, (_, index) => {
    const range = ranges.findLast(([start]) => start <= index);
    if (!range) return String(index + 1);
    const [start, d] = range;
    const st = d.lookup(name('St'));
    const n = (st instanceof PDFNumber ? st.asNumber() : 1) + index - start;
    const style = d.lookup(name('S'));
    const letters = () => String.fromCharCode(65 + ((n - 1) % 26)).repeat(Math.ceil(n / 26));
    const value = style === name('D') ? String(n) : style === name('R') ? roman(n).toUpperCase() : style === name('r') ? roman(n)
      : style === name('A') ? letters() : style === name('a') ? letters().toLowerCase() : '';
    return (text(d.lookup(name('P'))) ?? '') + value;
  });
}

/**
 * Call after the pages are in output order, before saving: rewrites /PageLabels so every page keeps its
 * source label (pages without one get their position), and drops objects no longer reachable, so content
 * of omitted pages is not written into the file.
 */
export function finishPdf(doc: PDFDocument): void {
  const pages = doc.getPages();
  const found = pages.map((page) => labels.get(page.node));
  if (found.some((label) => label !== undefined)) {
    const nums = doc.context.obj([]);
    found.forEach((label, i) => {
      nums.push(PDFNumber.of(i));
      nums.push(label === undefined ? doc.context.obj({ S: 'D', St: i + 1 }) : doc.context.obj({ P: PDFHexString.fromText(label) }));
    });
    doc.catalog.set(name('PageLabels'), doc.context.obj({ Nums: nums }));
  } else doc.catalog.delete(name('PageLabels'));

  const reached = new Set<PDFRef>();
  const info = doc.context.trailerInfo;
  const stack: PDFObject[] = [info.Root, info.Info, info.Encrypt].filter((o): o is PDFObject => !!o);
  while (stack.length) {
    const o = stack.pop()!;
    if (o instanceof PDFRef) {
      if (reached.has(o)) continue;
      reached.add(o);
      const value = doc.context.lookup(o);
      if (value) stack.push(value);
    } else if (o instanceof PDFDict) for (const [, v] of o.entries()) stack.push(v);
    else if (o instanceof PDFArray) stack.push(...o.asArray());
    else if (o instanceof PDFStream) stack.push(o.dict);
  }
  for (const [ref] of doc.context.enumerateIndirectObjects()) if (!reached.has(ref)) doc.context.delete(ref);
}

/** Return a catalog-preserving document with an empty page tree and mapped pages for insertion in output order. */
export async function preparePdf(sources: { bytes: Uint8Array; indices: number[] }[]): Promise<{ doc: PDFDocument; pages: PDFPage[][] }> {
  let out: PDFDocument | undefined;
  const result: PDFPage[][] = sources.map(() => []);
  for (const [sourceIndex, source] of sources.entries()) {
    // Repeated extraction ranges need distinct page/widget objects, not the same page ref twice in /Kids.
    const batches: { indices: number[]; positions: number[]; seen: Set<number> }[] = [];
    for (const [position, index] of source.indices.entries()) {
      let batch = batches.find((entry) => !entry.seen.has(index));
      if (!batch) { batch = { indices: [], positions: [], seen: new Set() }; batches.push(batch); }
      batch.seen.add(index);
      batch.indices.push(index);
      batch.positions.push(position);
    }
    for (const batch of batches) {
      const doc = await PDFDocument.load(source.bytes, { updateMetadata: false, preserveXFA: true });
      const pages = doc.getPages();
      const sourceLabels = pageLabels(doc, pages.length);
      const selected = new Set(batch.indices);
      for (const index of batch.indices) for (const key of PDFPageLeaf.InheritableEntries) {
        const value = pages[index].node.getInheritableAttribute(name(key));
        if (value && !pages[index].node.has(name(key))) pages[index].node.set(name(key), value);
      }
      // Detach before pruning references so /Kids and /Count stay consistent.
      for (let i = pages.length - 1; i >= 0; i--) doc.removePage(i);
      for (const index of batch.indices) doc.context.assign(pages[index].ref, pages[index].node);
      prunePages(doc, pages.filter((_, index) => !selected.has(index)));
      let imported: PDFPage[];
      if (!out) { out = doc; imported = batch.indices.map((index) => pages[index]); }
      else {
        const copier = PDFObjectCopier.for(doc.context, out.context);
        imported = batch.indices.map((index) => {
          const ref = copier.copy(pages[index].ref);
          return PDFPage.of(out!.context.lookup(ref) as PDFPageLeaf, ref, out!);
        });
        const catalog = PDFDict.withContext(doc.context);
        for (const key of ['AcroForm', 'Names', 'Dests', 'Outlines', 'OCProperties']) if (doc.catalog.has(name(key))) catalog.set(name(key), doc.catalog.get(name(key))!);
        const incoming = copier.copy(catalog);
        mergeForms(out, incoming);
        mergeNames(out, incoming, imported);
        mergeOutlines(out, incoming);
        mergeLayers(out, incoming);
      }
      batch.positions.forEach((position, i) => { result[sourceIndex][position] = imported[i]; });
      if (sourceLabels) batch.indices.forEach((index, i) => labels.set(imported[i].node, sourceLabels[index]));
    }
  }
  return { doc: out ?? await PDFDocument.create(), pages: result };
}
