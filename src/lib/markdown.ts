// markdown.ts — render trusted-source markdown to sanitized HTML.
//
// Source markdown comes from a GitHub repo the tester chose, but we still run
// it through DOMPurify: the app renders it with innerHTML, so sanitizing is
// the correct default. Crucially we do NOT allow `target` through the sanitizer:
// the checklist must not get to choose which tab a link lands in, and STAMP's
// named tabs intentionally keep their opener (see links.ts), so a doc-controlled
// target would be a doc-controlled opener handle on the run window.
// links.rewriteLinks is the SOLE assigner of target, and it runs over every
// rendered surface after insertion.

import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ gfm: true, breaks: false });

export function renderMarkdown(md: string): string {
  const html = marked.parse(md, { async: false }) as string;
  // Default DOMPurify already drops `target`; FORBID it explicitly so intent is
  // clear and immune to config drift, and drop any doc-supplied `rel` too.
  return DOMPurify.sanitize(html, { FORBID_ATTR: ['target', 'rel'] });
}
