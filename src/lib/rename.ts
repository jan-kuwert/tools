// Bulk-rename rules of the Files app (src/lib/files-app.ts); pure, so it runs under node --test.

export interface RenameOpts {
  /** Variables: {name} {ext} {id} {date} {today} {size}. */
  template: string;
  start: number;
  /** Zero-padding width of {id}. */
  pad: number;
  kase: 'keep' | 'lower' | 'upper' | 'title';
  spaces: 'keep' | 'dash' | 'underscore' | 'remove';
  find: string;
  replace: string;
  /** Set for regex find; must have the g flag. */
  re?: RegExp;
  strip: boolean;
  keepExt: boolean;
  lowerExt: boolean;
}

const SPACES = { dash: '-', underscore: '_', remove: '' };

/** [base, extension]; a leading dot (".gitignore") is part of the base. */
export const splitExt = (name: string): [string, string] => {
  const m = /^(.+)\.([^.]+)$/.exec(name);
  return m ? [m[1], m[2]] : [name, ''];
};

/** Local date as YYYY-MM-DD. */
export const ymd = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * New name for a file that is the `n`-th (0-based) one being renamed; '' when the base name ends up empty.
 * With keepExt the rules apply to the base name only and the extension is kept (optionally lowercased).
 */
export function renameOne(file: { name: string; lastModified: number; size: string }, n: number, o: RenameOpts, today: string): string {
  const [base, ext] = splitExt(file.name);
  const vars: Record<string, string> = { name: base, ext, id: String(o.start + n).padStart(o.pad, '0'), date: ymd(file.lastModified), today, size: file.size };
  let s = o.template.replace(/\{(name|ext|id|date|today|size)\}/g, (_, k: string) => vars[k]);
  if (o.find) s = o.re ? s.replace(o.re, o.replace) : s.replaceAll(o.find, o.replace);
  if (o.strip) s = s.replace(/[^\p{L}\p{N}\s._-]/gu, '');
  s = s.trim();
  if (o.spaces !== 'keep') s = s.replace(/\s+/g, SPACES[o.spaces]);
  if (o.kase === 'lower') s = s.toLocaleLowerCase();
  else if (o.kase === 'upper') s = s.toLocaleUpperCase();
  else if (o.kase === 'title') s = s.toLocaleLowerCase().replace(/(^|[^\p{L}\p{N}'’])(\p{L})/gu, (_, a: string, b: string) => a + b.toLocaleUpperCase());
  if (!o.keepExt || !ext || !s) return s;
  return `${s}.${o.lowerExt ? ext.toLowerCase() : ext}`;
}
