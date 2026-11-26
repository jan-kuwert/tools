export type Mode = 'local' | 'cloud';
export type Category = 'images' | 'pdf' | 'audio' | 'files';

export interface Tool {
  slug: string; // path below base, e.g. "images/convert"
  category: Category;
  title: string;
  /** Tab label on the home hub. */
  short: string;
  summary: string;
  mode: Mode;
  /** Shown before file selection. */
  limits: string;
}

/** `tabs`: tool slugs in hub tab order; the first is the default. */
export const categories: { id: Category; label: string; blurb: string; tabs: string[] }[] = [
  { id: 'images', label: 'Images', blurb: 'Edit, resize, convert and compress photos and graphics.', tabs: ['images/editor', 'images/remove-background', 'images/convert', 'images/resize'] },
  { id: 'pdf', label: 'PDF', blurb: 'Merge, split, reorder and optimize PDF documents.', tabs: ['pdf/organize', 'pdf/merge', 'pdf/split', 'pdf/from-images', 'pdf/compress'] },
  { id: 'audio', label: 'Audio', blurb: 'Trim, convert and shrink recordings and music.', tabs: ['audio/convert'] },
  { id: 'files', label: 'Files & text', blurb: 'Archives, compression, JSON and JavaScript.', tabs: ['text/json', 'text/js-minify', 'files/zip', 'files/gzip'] },
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
    category: 'pdf',
    title: 'Merge PDFs',
    short: 'Merge',
    summary: 'Combine several PDFs into one, in the order you choose.',
    mode: 'local',
    limits: 'Unencrypted PDFs · up to 200 MB total',
  },
  {
    slug: 'pdf/split',
    category: 'pdf',
    title: 'Split & extract pages',
    short: 'Split',
    summary: 'Pull out page ranges as separate PDFs.',
    mode: 'local',
    limits: 'One unencrypted PDF · up to 100 MB',
  },
  {
    slug: 'pdf/organize',
    category: 'pdf',
    title: 'Reorder, rotate & delete pages',
    short: 'Organize',
    summary: 'Rearrange pages visually and save a new PDF.',
    mode: 'local',
    limits: 'One unencrypted PDF · up to 100 MB · up to 500 pages',
  },
  {
    slug: 'pdf/from-images',
    category: 'pdf',
    title: 'Images to PDF',
    short: 'Images to PDF',
    summary: 'Turn photos or scans into a single PDF.',
    mode: 'local',
    limits: 'JPEG or PNG · up to 100 images',
  },
  {
    slug: 'pdf/compress',
    category: 'pdf',
    title: 'Optimize PDF',
    short: 'Optimize',
    summary: 'Lossless structural optimization. Smaller output is not guaranteed.',
    mode: 'local',
    limits: 'One unencrypted PDF · up to 100 MB',
  },
  {
    slug: 'audio/convert',
    category: 'audio',
    title: 'Convert & trim audio',
    short: 'Convert & trim',
    summary: 'Trim, cut and fade, then convert M4A, MP3, WAV, OGG and more to MP3, WAV or OGG. Optional cloud export to M4A, FLAC or Opus with tags kept.',
    mode: 'local',
    limits: 'Formats your browser can decode (M4A/AAC, MP3, WAV, OGG, FLAC) · up to 200 MB each · cloud export up to 30 MB',
  },
  {
    slug: 'files/zip',
    category: 'files',
    title: 'Create ZIP',
    short: 'ZIP',
    summary: 'Bundle several files into one archive.',
    mode: 'local',
    limits: 'Any files · up to 500 MB total',
  },
  {
    slug: 'files/gzip',
    category: 'files',
    title: 'Gzip / gunzip',
    short: 'Gzip',
    summary: 'Compress or decompress a single file.',
    mode: 'local',
    limits: 'One file · up to 200 MB · decompressed output up to 500 MB',
  },
  {
    slug: 'text/json',
    category: 'files',
    title: 'Format & minify JSON',
    short: 'JSON',
    summary: 'Validate, pretty-print or compact JSON without changing numbers.',
    mode: 'local',
    limits: 'Paste text or open a file up to 50 MB',
  },
  {
    slug: 'text/js-minify',
    category: 'files',
    title: 'Minify JavaScript',
    short: 'JavaScript',
    summary: 'Parser-based minification with Terser.',
    mode: 'local',
    limits: 'Paste code or open a file up to 10 MB',
  },
];

export const toolBySlug = (slug: string): Tool => {
  const t = tools.find((t) => t.slug === slug);
  if (!t) throw new Error(`Unknown tool: ${slug}`);
  return t;
};

/** Prefix an app-relative path with the configured base. */
export const href = (path = ''): string => `${import.meta.env.BASE_URL.replace(/\/$/, '')}/${path}`.replace(/\/?$/, '/');
