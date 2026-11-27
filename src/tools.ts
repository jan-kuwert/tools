export type Mode = 'local' | 'cloud';
export type Category = 'images' | 'pdf' | 'audio' | 'files' | 'text' | 'gpx';

export interface Tool {
  slug: string; // path below base, e.g. "images/convert"
  category: Category;
  title: string;
  /** Short label (picker rows, compact UI). */
  short: string;
  summary: string;
  mode: Mode;
  /** Shown before file selection. */
  limits: string;
  /** Mode of the category app that covers this tool (`<app>/?mode=<appMode>`); omitted = the app's default. */
  appMode?: string;
  /** false = no standalone page; the tool lives only inside its category app (see toolHref). */
  page?: false;
}

/**
 * Each category has one integrated app page shown full screen on its hub screen (`app` = page slug).
 * Individual tool pages stay available standalone; the hub opens the app in the matching mode instead.
 */
export const categories: { id: Category; label: string; blurb: string; app: string }[] = [
  { id: 'images', label: 'Images', blurb: 'Edit, resize, convert and compress photos and graphics.', app: 'images/editor' },
  { id: 'pdf', label: 'PDF', blurb: 'View, merge, split, reorder and optimize PDF documents.', app: 'pdf' },
  { id: 'audio', label: 'Audio', blurb: 'Trim, convert and shrink recordings and music.', app: 'audio/convert' },
  { id: 'files', label: 'Files', blurb: 'Explore, bulk rename, zip and extract files and folders.', app: 'files' },
  { id: 'text', label: 'Text', blurb: 'Edit, format, minify and compare JSON, JavaScript and Markdown.', app: 'text' },
  { id: 'gpx', label: 'GPX', blurb: 'Merge, trim, clean up and edit GPS tracks from runs, rides and watches.', app: 'gpx' },
];

export const tools: Tool[] = [
  {
    slug: 'images/editor',
    category: 'images',
    title: 'Image editor',
    short: 'Editor',
    summary: 'Resize, crop to a frame, compress and convert in one place.',
    mode: 'local',
    limits: 'JPEG, PNG or WebP · up to 16.7 megapixels each',
  },
  {
    slug: 'images/remove-background',
    category: 'images',
    title: 'Remove background',
    short: 'Remove background',
    summary: 'Cut out the subject and get a transparent PNG.',
    mode: 'cloud',
    limits: 'JPEG, PNG or WebP · up to 20 MB · up to 24 megapixels · one image at a time',
  },
  {
    slug: 'images/convert',
    category: 'images',
    title: 'Convert & compress images',
    short: 'Convert',
    summary: 'Switch between JPEG, PNG and WebP and shrink file size.',
    mode: 'local',
    limits: 'JPEG, PNG or WebP · up to 16.7 megapixels each',
  },
  {
    slug: 'images/resize',
    category: 'images',
    title: 'Resize images',
    short: 'Resize',
    summary: 'Scale to a width or height, keeping proportions.',
    mode: 'local',
    limits: 'JPEG, PNG or WebP · up to 16.7 megapixels each',
  },
  {
    slug: 'pdf/merge',
    appMode: 'merge',
    category: 'pdf',
    title: 'Merge PDFs',
    short: 'Merge',
    summary: 'Combine several PDFs into one, in the order you choose.',
    mode: 'local',
    limits: 'Unencrypted PDFs · up to 200 MB total',
  },
  {
    slug: 'pdf/split',
    appMode: 'split',
    category: 'pdf',
    title: 'Split & extract pages',
    short: 'Split',
    summary: 'Pull out page ranges as separate PDFs.',
    mode: 'local',
    limits: 'One unencrypted PDF · up to 100 MB',
  },
  {
    slug: 'pdf/organize',
    appMode: 'organize',
    category: 'pdf',
    title: 'Reorder, rotate & delete pages',
    short: 'Organize',
    summary: 'Rearrange pages visually and save a new PDF.',
    mode: 'local',
    limits: 'One unencrypted PDF · up to 100 MB · up to 500 pages',
  },
  {
    slug: 'pdf/from-images',
    appMode: 'from-images',
    category: 'pdf',
    title: 'Images to PDF',
    short: 'Images to PDF',
    summary: 'Turn photos or scans into a single PDF.',
    mode: 'local',
    limits: 'JPEG or PNG · up to 100 images',
  },
  {
    slug: 'pdf/compress',
    appMode: 'compress',
    category: 'pdf',
    title: 'Optimize PDF',
    short: 'Optimize',
    summary: 'Lossless structural optimization. Smaller output is not guaranteed.',
    mode: 'local',
    limits: 'One unencrypted PDF · up to 100 MB',
  },
  {
    slug: 'audio/convert',
    appMode: 'convert',
    category: 'audio',
    title: 'Convert audio',
    short: 'Convert',
    summary: 'M4A, MP3, WAV, OGG, FLAC and more to MP3, WAV or OGG, keeping the source quality.',
    mode: 'local',
    limits: 'Formats your browser can decode (M4A/AAC, MP3, WAV, OGG, FLAC) · up to 200 MB each',
  },
  ...[
    ['trim', 'Trim audio', 'Keep only the part you select, accurate to the sample.'],
    ['cut', 'Cut out a section', 'Remove a selected part and join the rest.'],
    ['fade', 'Fade in & fade out', 'Add smooth fades at the start and end.'],
    ['silence', 'Remove silence', 'Detect silent intros and outros and trim them.'],
  ].map(([m, title, summary]): Tool => ({
    slug: `audio/${m}`, appMode: m, page: false, category: 'audio', title, short: title, summary, mode: 'local',
    limits: 'Formats your browser can decode · up to 200 MB',
  })),
  {
    slug: 'audio/cloud-export', appMode: 'cloud', page: false, category: 'audio', title: 'Convert to M4A, FLAC or Opus', short: 'M4A / FLAC / Opus',
    summary: 'Export with tags and cover art kept, processed on our EU server.', mode: 'cloud', limits: 'One file · up to 30 MB',
  },
  {
    slug: 'files/zip',
    appMode: 'zip',
    category: 'files',
    title: 'Create ZIP',
    short: 'ZIP',
    summary: 'Bundle several files into one archive.',
    mode: 'local',
    limits: 'Any files · up to 500 MB total',
  },
  {
    slug: 'files/gzip',
    appMode: 'gzip',
    category: 'files',
    title: 'Gzip / gunzip',
    short: 'Gzip',
    summary: 'Compress or decompress a single file.',
    mode: 'local',
    limits: 'One file · up to 200 MB · decompressed output up to 500 MB',
  },
  {
    slug: 'text/json',
    appMode: 'json',
    category: 'text',
    title: 'Format & minify JSON',
    short: 'JSON',
    summary: 'Validate, pretty-print or compact JSON without changing numbers.',
    mode: 'local',
    limits: 'Paste text or open a file up to 50 MB',
  },
  {
    slug: 'text/js-minify',
    appMode: 'js',
    category: 'text',
    title: 'Minify JavaScript',
    short: 'JavaScript',
    summary: 'Parser-based minification with Terser.',
    mode: 'local',
    limits: 'Paste code or open a file up to 10 MB',
  },
  ...[
    ['extract', 'Extract archives', 'Unpack ZIP, 7z, RAR, tar, gz, xz and bz2 files.'],
    ['7z', 'Create 7z archive', '7-Zip archives with optional AES-256 password.'],
    ['rename', 'Bulk rename files', 'Rename many files at once with a pattern, numbering and case rules.'],
  ].map(([m, title, summary]): Tool => ({
    slug: `files/${m}`, appMode: m, page: false, category: 'files', title, short: title, summary, mode: 'local',
    limits: 'Runs in your browser',
  })),
  ...[
    ['compare', 'Compare text', 'Side-by-side diff with highlighted changes; JSON-aware.'],
    ['markdown', 'Markdown preview', 'Write or open Markdown and see it rendered.'],
  ].map(([m, title, summary]): Tool => ({
    slug: `text/${m}`, appMode: m, page: false, category: 'text', title, short: title, summary, mode: 'local',
    limits: 'Runs in your browser',
  })),
  ...[
    ['edit', 'Edit GPX tracks', 'Trim, cut, split and clean up tracks point by point on the map and elevation profile.'],
    ['merge', 'Merge GPX files', 'Join several activities or track parts into one GPX, in time order.'],
    ['clean', 'Clean up GPS tracks', 'Remove pauses, GPS spikes and private start/end zones; simplify.'],
  ].map(([m, title, summary]): Tool => ({
    slug: `gpx/${m}`, appMode: m, page: false, category: 'gpx', title, short: title, summary, mode: 'local',
    limits: 'GPX 1.0/1.1 files · up to 50 MB each',
  })),
  ...[
    ['crop', 'Crop images', 'Crop to a ratio or a free selection.'],
    ['flip', 'Rotate & flip images', 'Rotate in 90° steps and mirror on either axis.'],
    ['merge', 'Merge images', 'Arrange several images side by side and combine them into one.'],
    ['svg', 'SVG to PNG / JPEG / WebP', 'Rasterize SVG files sharply at any size.'],
  ].map(([m, title, summary]): Tool => ({
    slug: `images/${m}`, appMode: m, page: false, category: 'images', title, short: title, summary, mode: 'local',
    limits: 'JPEG, PNG, WebP or SVG · up to 16.7 megapixels each',
  })),
  ...[
    ['rotate', 'Rotate PDF pages', 'Turn single pages or the whole document.'],
    ['delete', 'Delete PDF pages', 'Remove pages you don’t need.'],
  ].map(([m, title, summary]): Tool => ({
    slug: `pdf/${m}`, appMode: 'organize', page: false, category: 'pdf', title, short: title, summary, mode: 'local',
    limits: 'Unencrypted PDFs · up to 200 MB',
  })),
];

export const toolBySlug = (slug: string): Tool => {
  const t = tools.find((t) => t.slug === slug);
  if (!t) throw new Error(`Unknown tool: ${slug}`);
  return t;
};

/** Prefix an app-relative path with the configured base. */
export const href = (path = ''): string => `${import.meta.env.BASE_URL.replace(/\/$/, '')}/${path}`.replace(/\/?$/, '/');

/** Standalone URL for a tool: its own page, or its category app opened in the tool's mode. */
export const toolHref = (t: Tool): string => {
  if (t.page !== false) return href(t.slug);
  const app = categories.find((c) => c.id === t.category)!.app;
  return `${href(app)}?mode=${t.appMode}`;
};
