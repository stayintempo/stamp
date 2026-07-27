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

  // --- bare @ref shorthand ---
  it('pins a bare path to a tag with @ref', () => {
    expect(parseSourceUrl('acme/coffee-qa/QA@v1.2.0')).toEqual({
      owner: 'acme',
      repo: 'coffee-qa',
      ref: 'v1.2.0',
      path: 'QA',
      kind: 'bare',
    });
  });

  it('pins the repo root when there is no path', () => {
    expect(parseSourceUrl('acme/coffee-qa@deadbeef')).toEqual({
      owner: 'acme',
      repo: 'coffee-qa',
      ref: 'deadbeef',
      path: '',
      kind: 'bare',
    });
  });

  it('keeps slashes in a branch ref, which a tree URL cannot express', () => {
    expect(parseSourceUrl('acme/coffee-qa/QA@fix/my-branch')).toMatchObject({
      ref: 'fix/my-branch',
      path: 'QA',
    });
  });

  it('takes the FIRST @ so a tag containing @ survives', () => {
    expect(parseSourceUrl('acme/coffee-qa/QA@stamp@0.1.0')).toMatchObject({
      ref: 'stamp@0.1.0',
      path: 'QA',
    });
  });

  it('strips .git before the ref', () => {
    expect(parseSourceUrl('acme/coffee-qa.git@v1')).toMatchObject({ repo: 'coffee-qa', ref: 'v1' });
  });

  // --- @ref negatives ---
  it('rejects a trailing @ with nothing after it', () => {
    expect(() => parseSourceUrl('acme/coffee-qa/QA@')).toThrow(GithubError);
  });

  it('does NOT apply the shorthand to https URLs, where @ stays part of the path', () => {
    expect(parseSourceUrl('https://github.com/acme/coffee-qa/QA@v1')).toEqual({
      owner: 'acme',
      repo: 'coffee-qa',
      path: 'QA@v1',
      kind: 'bare',
    });
  });

  it('swallows a path segment containing @ (documented cost of the shorthand)', () => {
    // '@scope' folders are unreachable bare; a tree URL is the escape hatch.
    expect(parseSourceUrl('acme/coffee-qa/packages/@scope/QA')).toMatchObject({
      ref: 'scope/QA',
      path: 'packages',
    });
  });

  it('leaves ref undefined when there is no @, so the default branch is used', () => {
    expect(parseSourceUrl('acme/coffee-qa/QA').ref).toBeUndefined();
  });

  it('tolerates spaces around the @, which would otherwise ride along invisibly', () => {
    // 'QA ' with a trailing space fails later as an unfindable path, and the
    // space is invisible in the error, so trim rather than pass it through.
    expect(parseSourceUrl('acme/coffee-qa/QA @v1.2.0')).toMatchObject({ ref: 'v1.2.0', path: 'QA' });
    expect(parseSourceUrl('acme/coffee-qa/QA@ v1.2.0')).toMatchObject({ ref: 'v1.2.0', path: 'QA' });
  });

  it('rejects an @ followed only by whitespace (negative)', () => {
    expect(() => parseSourceUrl('acme/coffee-qa/QA@   ')).toThrow(GithubError);
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
