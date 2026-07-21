// markdown.ts — render trusted-source markdown to sanitized HTML.
//
// Source markdown comes from a GitHub repo the tester chose, but we still run
// it through DOMPurify: the app renders it with innerHTML, so sanitizing is
// the correct default. `target` is allowed through; rel/target are finalized
// by links.rewriteLinks after insertion.

import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ gfm: true, breaks: false });

export function renderMarkdown(md: string): string {
  const html = marked.parse(md, { async: false }) as string;
  return DOMPurify.sanitize(html, { ADD_ATTR: ['target'] });
}
