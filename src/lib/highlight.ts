// Syntax highlighting for the Files & text editor and Markdown code blocks. Lazy-loaded: only the languages below.
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

for (const [name, lang] of Object.entries({ bash, css, javascript, json, markdown, python, sql, typescript, xml, yaml })) hljs.registerLanguage(name, lang);

/** Escaped HTML with hljs-* spans; unknown languages fall back to escaped plain text. */
export function highlight(code: string, language: string): string {
  if (!hljs.getLanguage(language)) return code.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
  return hljs.highlight(code, { language, ignoreIllegals: true }).value;
}

export const hasLanguage = (language: string): boolean => !!hljs.getLanguage(language);
