export type Mode = 'local' | 'cloud';
export type Category = 'images' | 'pdf' | 'audio' | 'files' | 'text';

export interface Tool {
  slug: string; // path below base, e.g. "images/convert"
  category: Category;
  title: string;
  summary: string;
  mode: Mode;
  /** Shown before file selection. */
  limits: string;
}

export const categories: { id: Category; label: string }[] = [
  { id: 'images', label: 'Images' },
  { id: 'pdf', label: 'PDF' },
  { id: 'audio', label: 'Audio' },
  { id: 'files', label: 'Files' },
  { id: 'text', label: 'Text' },
];

export const tools: Tool[] = [
  {
    slug: 'images/remove-background',
    category: 'images',
    title: 'Remove background',
    summary: 'Cut out the subject and get a transparent PNG.',
    mode: 'cloud',
    limits: 'JPEG, PNG or WebP · up to 20 MB · up to 24 megapixels · one image at a time',
  },
  {
    slug: 'images/convert',
    category: 'images',
    title: 'Convert & compress images',
    summary: 'Switch between JPEG, PNG and WebP and shrink file size.',
    mode: 'local',
    limits: 'JPEG, PNG or WebP · up to 16.7 megapixels each',
  },
  {
    slug: 'images/resize',
    category: 'images',
    title: 'Resize images',
    summary: 'Scale to a width or height, keeping proportions.',
    mode: 'local',
    limits: 'JPEG, PNG or WebP · up to 16.7 megapixels each',
  },
  {
    slug: 'pdf/merge',
    category: 'pdf',
    title: 'Merge PDFs',
    summary: 'Combine several PDFs into one, in the order you choose.',
    mode: 'local',
    limits: 'Unencrypted PDFs · up to 200 MB total',
  },
  {
    slug: 'pdf/split',
    category: 'pdf',
    title: 'Split & extract pages',
    summary: 'Pull out page ranges as separate PDFs.',
    mode: 'local',
    limits: 'One unencrypted PDF · up to 100 MB',
  },
  {
    slug: 'pdf/organize',
    category: 'pdf',
    title: 'Reorder, rotate & delete pages',
    summary: 'Rearrange pages visually and save a new PDF.',
    mode: 'local',
    limits: 'One unencrypted PDF · up to 100 MB · up to 500 pages',
  },
  {
    slug: 'pdf/from-images',
    category: 'pdf',
    title: 'Images to PDF',
    summary: 'Turn photos or scans into a single PDF.',
    mode: 'local',
    limits: 'JPEG or PNG · up to 100 images',
  },
  {
    slug: 'pdf/compress',
    category: 'pdf',
    title: 'Optimize PDF',
    summary: 'Lossless structural optimization. Smaller output is not guaranteed.',
    mode: 'local',
    limits: 'One unencrypted PDF · up to 100 MB',
  },
  {
    slug: 'audio/convert',
    category: 'audio',
    title: 'Convert audio',
    summary: 'M4A, MP3, WAV, OGG and more to MP3, WAV or OGG.',
    mode: 'local',
    limits: 'Formats your browser can decode (M4A/AAC, MP3, WAV, OGG, FLAC) · up to 200 MB each',
  },
  {
    slug: 'files/zip',
    category: 'files',
    title: 'Create ZIP',
    summary: 'Bundle several files into one archive.',
    mode: 'local',
    limits: 'Any files · up to 500 MB total',
  },
  {
    slug: 'files/gzip',
    category: 'files',
    title: 'Gzip / gunzip',
    summary: 'Compress or decompress a single file.',
    mode: 'local',
    limits: 'One file · up to 200 MB · decompressed output up to 500 MB',
  },
  {
    slug: 'text/json',
    category: 'text',
    title: 'Format & minify JSON',
    summary: 'Validate, pretty-print or compact JSON without changing numbers.',
    mode: 'local',
    limits: 'Paste text or open a file up to 50 MB',
  },
  {
    slug: 'text/js-minify',
    category: 'text',
    title: 'Minify JavaScript',
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
