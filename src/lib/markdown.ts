// Markdown preview (CommonMark + GFM via micromark). Lazy-loaded. Raw HTML stays escaped and unsafe link
// protocols are dropped (micromark defaults); remote images are never fetched.
import { micromark } from 'micromark';
import { gfm, gfmHtml } from 'micromark-extension-gfm';
import { highlight, hasLanguage } from './highlight';

/** Rendered, post-processed preview content as an inert fragment. */
export function renderMarkdown(source: string): DocumentFragment {
  const tpl = document.createElement('template');
  // micromark output is generated HTML: user text is escaped, raw HTML is not allowed (allowDangerousHtml stays off).
  tpl.innerHTML = micromark(source, { extensions: [gfm()], htmlExtensions: [gfmHtml()] });
  const root = tpl.content;
  for (const a of root.querySelectorAll('a[href]')) {
    // micromark empties unsafe hrefs (javascript: etc.); drop them so the link is plain text.
    if (!a.getAttribute('href')) {
      a.removeAttribute('href');
      continue;
    }
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
  }
  for (const img of root.querySelectorAll('img')) {
    const src = img.getAttribute('src') ?? '';
    const note = document.createElement('a');
    note.className = 'md-img-off';
    note.textContent = `image: ${img.getAttribute('alt') || 'untitled'} (remote images are not loaded)`;
    if (/^https?:/i.test(src)) {
      note.href = src;
      note.target = '_blank';
      note.rel = 'noopener noreferrer';
    }
    img.replaceWith(note);
  }
  for (const code of root.querySelectorAll('pre > code')) {
    const lang = /language-([\w-]+)/.exec(code.className)?.[1];
    if (lang && hasLanguage(lang)) {
      // highlight() returns escaped HTML built from the code text.
      code.innerHTML = highlight(code.textContent ?? '', lang);
      code.classList.add('hljs');
    }
  }
  return root;
}

/** A standalone HTML document for "Download HTML": the same sanitized content, minimal inline styles. */
export function markdownDocument(title: string, body: DocumentFragment): string {
  const box = document.createElement('div');
  box.append(body.cloneNode(true));
  const esc = title.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc}</title>
<style>
body { max-width: 46rem; margin: 2rem auto; padding: 0 1rem; font: 16px/1.6 system-ui, sans-serif; color: #17181a; }
pre { padding: 0.75rem 1rem; overflow: auto; background: #f4f4f1; border-radius: 8px; }
code { font: 0.9em ui-monospace, Menlo, Consolas, monospace; }
table { border-collapse: collapse; } th, td { border: 1px solid #ddd; padding: 0.3rem 0.6rem; }
blockquote { margin: 0; padding-left: 1rem; border-left: 3px solid #ddd; color: #555; }
img, .md-img-off { color: #555; }
</style>
</head>
<body>
${box.innerHTML}
</body>
</html>
`;
}
