import { describe, it, expect } from 'vitest';
import { parseSourceUrl, GithubError } from '../src/lib/github';

describe('parseSourceUrl', () => {
  it('parses a tree URL with a path', () => {
    expect(parseSourceUrl('https://github.com/acme/coffee-qa/tree/main/QA')).toEqual({
      owner: 'acme',
      repo: 'coffee-qa',
      ref: 'main',
      path: 'QA',
      kind: 'tree',
    });
  });

  it('parses a blob URL to a single markdown file', () => {
    expect(parseSourceUrl('https://github.com/acme/coffee-qa/blob/v1.2.0/QA/steps.md')).toEqual({
      owner: 'acme',
      repo: 'coffee-qa',
      ref: 'v1.2.0',
      path: 'QA/steps.md',
      kind: 'blob',
    });
  });

  it('parses a bare owner/repo with default ref', () => {
    expect(parseSourceUrl('acme/coffee-qa')).toEqual({
      owner: 'acme',
      repo: 'coffee-qa',
      path: '',
      kind: 'bare',
    });
  });

  it('parses bare owner/repo/path', () => {
    expect(parseSourceUrl('acme/coffee-qa/QA')).toMatchObject({ path: 'QA', kind: 'bare' });
  });

  it('parses a plain repo URL as bare (no ref)', () => {
    expect(parseSourceUrl('https://github.com/acme/coffee-qa')).toEqual({
      owner: 'acme',
      repo: 'coffee-qa',
      path: '',
      kind: 'bare',
    });
  });

  it('strips a trailing .git', () => {
    expect(parseSourceUrl('acme/coffee-qa.git').repo).toBe('coffee-qa');
  });

  // --- negatives ---
  it('rejects a non-github host', () => {
    expect(() => parseSourceUrl('https://gitlab.com/acme/coffee-qa')).toThrow(GithubError);
  });

  it('rejects an arbitrary non-URL string', () => {
    expect(() => parseSourceUrl('just some words')).toThrow(GithubError);
  });

  it('rejects an empty input', () => {
    expect(() => parseSourceUrl('   ')).toThrow(GithubError);
  });

  it('rejects a tree URL missing its ref', () => {
    expect(() => parseSourceUrl('https://github.com/acme/coffee-qa/tree')).toThrow(GithubError);
  });
});
