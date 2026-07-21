import { describe, it, expect } from 'vitest';
import {
  resolvePath,
  resolveLink,
  rewriteLinks,
  suggestAppHost,
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
});

describe('rewriteLinks (DOM)', () => {
  it('sets target + rel on every anchor', () => {
    const div = document.createElement('div');
    div.innerHTML =
      '<a href="https://machine.local/x">app</a> <a href="../MANUAL.md">doc</a> <a href="https://other.test/y">ext</a>';
    rewriteLinks(div, ctx);
    const [app, rel, ext] = Array.from(div.querySelectorAll('a'));
    expect(app.getAttribute('target')).toBe(APP_TAB);
    expect(app.getAttribute('rel')).toBe('noopener noreferrer');
    expect(rel.getAttribute('href')).toContain('github.com/acme/coffee-qa/blob/deadbeef/QA/MANUAL.md');
    expect(rel.getAttribute('target')).toBe(DOCS_TAB);
    expect(ext.getAttribute('target')).toBe(DOCS_TAB);
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
