import { describe, it, expect } from 'vitest';
import {
  resolvePath,
  resolveLink,
  rewriteLinks,
  suggestAppHost,
  normalizeAppHost,
  APP_TAB,
  DOCS_TAB,
  type LinkContext,
} from '../src/lib/links';

const ctx: LinkContext = {
  appHost: 'machine.local',
  owner: 'acme',
  repo: 'coffee-qa',
  sha: 'deadbeef',
  filePath: 'QA/01_Brewing/README.md',
};

describe('resolvePath', () => {
  it('resolves .. against the file directory', () => {
    expect(resolvePath('QA/01_Brewing', '../MANUAL.md')).toBe('QA/MANUAL.md');
  });
  it('resolves sibling folders', () => {
    expect(resolvePath('QA/01_Brewing', '../02_Cleaning/README.md')).toBe('QA/02_Cleaning/README.md');
  });
  it('treats a leading slash as repo-root absolute', () => {
    expect(resolvePath('QA/01_Brewing', '/RELEASE.md')).toBe('RELEASE.md');
  });
});

describe('resolveLink', () => {
  it('routes the app host to the reusable app tab', () => {
    expect(resolveLink('https://machine.local/panel', ctx)).toEqual({
      href: 'https://machine.local/panel',
      tab: APP_TAB,
    });
  });

  it('routes other absolute links to the docs tab', () => {
    expect(resolveLink('https://example.com/x', ctx)).toEqual({
      href: 'https://example.com/x',
      tab: DOCS_TAB,
    });
  });

  it('rewrites a relative link to the pinned GitHub blob', () => {
    expect(resolveLink('../MANUAL.md', ctx)).toEqual({
      href: 'https://github.com/acme/coffee-qa/blob/deadbeef/QA/MANUAL.md',
      tab: DOCS_TAB,
    });
  });

  it('rewrites a bare #anchor against the source file', () => {
    expect(resolveLink('#setup', ctx)).toEqual({
      href: 'https://github.com/acme/coffee-qa/blob/deadbeef/QA/01_Brewing/README.md#setup',
      tab: DOCS_TAB,
    });
  });

  it('preserves an anchor on a relative path', () => {
    expect(resolveLink('../MANUAL.md#grind', ctx)!.href).toBe(
      'https://github.com/acme/coffee-qa/blob/deadbeef/QA/MANUAL.md#grind',
    );
  });

  it('falls back to the docs tab when no app host is configured', () => {
    const noHost: LinkContext = { ...ctx, appHost: undefined };
    expect(resolveLink('https://machine.local/panel', noHost)!.tab).toBe(DOCS_TAB);
  });

  it('matches an app host that includes a port (M2)', () => {
    const ported: LinkContext = { ...ctx, appHost: 'localhost:5173' };
    expect(resolveLink('http://localhost:5173/x', ported)!.tab).toBe(APP_TAB);
    // negative: a different port is NOT the app host
    expect(resolveLink('http://localhost:3000/x', ported)!.tab).toBe(DOCS_TAB);
    // negative: bare host without the port does not match a ported app host
    expect(resolveLink('http://localhost/x', ported)!.tab).toBe(DOCS_TAB);
  });

  it('tolerates a user-entered app host with scheme/path/trailing slash (M2)', () => {
    const messy: LinkContext = { ...ctx, appHost: 'https://Machine.Local/panel/' };
    expect(resolveLink('https://machine.local/x', messy)!.tab).toBe(APP_TAB);
  });

  it('treats a protocol-relative //host href as absolute, not repo-relative (L6)', () => {
    const r = resolveLink('//cdn.example.com/asset.js', ctx)!;
    expect(r.href).toBe('https://cdn.example.com/asset.js');
    expect(r.tab).toBe(DOCS_TAB);
    // and it routes to the app tab when it is the app host
    const app: LinkContext = { ...ctx, appHost: 'machine.local' };
    expect(resolveLink('//machine.local/panel', app)!.tab).toBe(APP_TAB);
  });
});

describe('normalizeAppHost', () => {
  it('strips scheme, path, trailing slash and lowercases; keeps the port', () => {
    expect(normalizeAppHost('https://App.Example.com:8443/foo/')).toBe('app.example.com:8443');
    expect(normalizeAppHost('  localhost:5173  ')).toBe('localhost:5173');
    expect(normalizeAppHost(undefined)).toBe('');
    expect(normalizeAppHost('')).toBe('');
  });
});

describe('rewriteLinks (DOM)', () => {
  it('sets target + referrerpolicy on every anchor', () => {
    const div = document.createElement('div');
    div.innerHTML =
      '<a href="https://machine.local/x">app</a> <a href="../MANUAL.md">doc</a> <a href="https://other.test/y">ext</a>';
    rewriteLinks(div, ctx);
    const [app, rel, ext] = Array.from(div.querySelectorAll('a'));
    expect(app.getAttribute('target')).toBe(APP_TAB);
    expect(app.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(rel.getAttribute('href')).toContain('github.com/acme/coffee-qa/blob/deadbeef/QA/MANUAL.md');
    expect(rel.getAttribute('target')).toBe(DOCS_TAB);
    expect(ext.getAttribute('target')).toBe(DOCS_TAB);
  });

  // Regression guard. rel=noopener makes the browser skip the "find a navigable
  // by target name" lookup entirely, so a named target can never be reused and
  // every click spawns a new tab — the exact bug the reusable qa-app/qa-docs
  // tabs exist to avoid. rel=noreferrer implies noopener, so neither may appear.
  it('never emits noopener or noreferrer, which would break named-tab reuse', () => {
    const div = document.createElement('div');
    div.innerHTML =
      '<a href="https://machine.local/x">app</a> <a href="../MANUAL.md">doc</a> <a href="https://other.test/y">ext</a>';
    rewriteLinks(div, ctx);
    for (const a of Array.from(div.querySelectorAll('a'))) {
      expect(a.hasAttribute('rel')).toBe(false);
    }
    expect(div.innerHTML).not.toMatch(/noopener|noreferrer/);
  });

  it('strips a doc-supplied rel rather than leaving it to re-add noopener', () => {
    const div = document.createElement('div');
    div.innerHTML = '<a href="https://other.test/y" rel="noopener">ext</a>';
    rewriteLinks(div, ctx);
    const a = div.querySelector('a')!;
    expect(a.hasAttribute('rel')).toBe(false);
    expect(a.getAttribute('target')).toBe(DOCS_TAB);
  });
});

describe('suggestAppHost', () => {
  it('picks the most frequent non-github host', () => {
    const md = [
      'See https://machine.local/a and https://machine.local/b',
      'and https://machine.local/c but only https://other.test/z once.',
      'Ignore https://github.com/acme/coffee-qa too.',
    ].join('\n');
    expect(suggestAppHost(md)).toBe('machine.local');
  });

  it('returns undefined when there are no external hosts', () => {
    expect(suggestAppHost('no links here, just prose')).toBeUndefined();
  });
});
