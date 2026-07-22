import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '../src/lib/markdown';
import { rewriteLinks, APP_TAB, DOCS_TAB, type LinkContext } from '../src/lib/links';

const ctx: LinkContext = {
  appHost: 'machine.local',
  owner: 'acme',
  repo: 'coffee-qa',
  sha: 'deadbeef',
  filePath: 'QA/01_Brewing/README.md',
};

describe('renderMarkdown sanitization (XSS negatives)', () => {
  it('strips <script> tags', () => {
    const html = renderMarkdown('hello\n\n<script>alert(1)</script>\n\nworld');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('alert(1)');
  });

  it('strips inline event handlers like img onerror', () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)">');
    expect(html).not.toContain('onerror');
  });

  it('neutralizes a javascript: href', () => {
    const html = renderMarkdown('[click](javascript:alert(1))');
    expect(html.toLowerCase()).not.toContain('javascript:alert');
  });

  it('does NOT let a doc-supplied target survive the sanitizer (tabnabbing)', () => {
    // A raw anchor with target must lose its target at sanitize time; only
    // rewriteLinks may (re)assign target, and it always pairs it with noopener.
    const html = renderMarkdown('<a href="https://evil.example/x" target="_blank">x</a>');
    expect(html).not.toContain('target');
  });

  it('does NOT let a doc-supplied rel survive the sanitizer', () => {
    const html = renderMarkdown('<a href="https://evil.example/x" rel="opener">x</a>');
    expect(html).not.toMatch(/rel=/i);
  });
});

describe('rewriteLinks tabnabbing hardening', () => {
  it('normalizes a raw <a target> to a safe named target + rel', () => {
    const div = document.createElement('div');
    // Simulate a surface where a target somehow slipped in: rewriteLinks must
    // overwrite it with a safe named tab and add rel=noopener noreferrer.
    div.innerHTML = '<a href="https://machine.local/x" target="_blank">app</a>';
    rewriteLinks(div, ctx);
    const a = div.querySelector('a')!;
    expect(a.getAttribute('target')).toBe(APP_TAB);
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('rewrites area[href] hotspots too, not just anchors', () => {
    const div = document.createElement('div');
    div.innerHTML =
      '<map><area href="https://other.test/y" target="_blank"><area href="../MANUAL.md"></map>';
    rewriteLinks(div, ctx);
    const [ext, rel] = Array.from(div.querySelectorAll('area'));
    expect(ext.getAttribute('target')).toBe(DOCS_TAB);
    expect(ext.getAttribute('rel')).toBe('noopener noreferrer');
    expect(rel.getAttribute('href')).toContain('github.com/acme/coffee-qa/blob/deadbeef/QA/MANUAL.md');
    expect(rel.getAttribute('target')).toBe(DOCS_TAB);
  });

  it('end-to-end: rendered markdown carries no target until rewriteLinks runs', () => {
    const div = document.createElement('div');
    div.innerHTML = renderMarkdown('[app](https://machine.local/panel) and [ext](https://other.test/z)');
    // After sanitize, no anchor has a target yet.
    for (const a of Array.from(div.querySelectorAll('a'))) {
      expect(a.hasAttribute('target')).toBe(false);
    }
    rewriteLinks(div, ctx);
    const [app, ext] = Array.from(div.querySelectorAll('a'));
    expect(app.getAttribute('target')).toBe(APP_TAB);
    expect(ext.getAttribute('target')).toBe(DOCS_TAB);
    for (const a of Array.from(div.querySelectorAll('a'))) {
      expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    }
  });
});
