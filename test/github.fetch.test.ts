import { describe, it, expect, vi } from 'vitest';
import { GithubClient, GithubError, loadRunDoc, parseSourceUrl } from '../src/lib/github';

// Minimal Response-like builder for the injected fetch.
function res(
  body: unknown,
  init: { status?: number; headers?: Record<string, string>; text?: string } = {},
): Response {
  const status = init.status ?? 200;
  const headers = new Headers(init.headers ?? {});
  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    json: async () => body,
    text: async () => (init.text !== undefined ? init.text : String(body)),
  } as unknown as Response;
}

function clientWith(fetchImpl: typeof fetch, token?: string) {
  return new GithubClient({ fetchImpl, token });
}

describe('GithubClient happy paths', () => {
  it('resolves a commit SHA', async () => {
    const fetchImpl = vi.fn(async () => res({ sha: 'abc123' }));
    const c = clientWith(fetchImpl as unknown as typeof fetch);
    expect(await c.resolveCommitSha('o', 'r', 'main')).toBe('abc123');
  });

  it('sends a Bearer token when configured', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => res({ default_branch: 'trunk' }));
    const c = clientWith(fetchImpl as unknown as typeof fetch, 'secret');
    await c.getDefaultBranch('o', 'r');
    const headers = (fetchImpl.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer secret');
  });

  it('omits Authorization when tokenless', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => res({ default_branch: 'main' }));
    const c = clientWith(fetchImpl as unknown as typeof fetch);
    await c.getDefaultBranch('o', 'r');
    const headers = (fetchImpl.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it('rejects a truncated tree', async () => {
    const fetchImpl = vi.fn(async () => res({ tree: [], truncated: true }));
    const c = clientWith(fetchImpl as unknown as typeof fetch);
    await expect(c.listTree('o', 'r', 'sha')).rejects.toThrow(/too large/);
  });

  it('discovers open issues carrying the STAMP marker and skips PRs', async () => {
    const fetchImpl = vi.fn(async () =>
      res([
        { number: 1, html_url: 'u1', title: 't1', body: 'has <!-- stamp:v1 {} --> marker' },
        { number: 2, html_url: 'u2', title: 't2', body: 'no marker' },
        { number: 3, html_url: 'u3', title: 't3', body: 'stamp:v1', pull_request: {} },
      ]),
    );
    const c = clientWith(fetchImpl as unknown as typeof fetch);
    const found = await c.listStampIssues('o', 'r', 'stamp:v1');
    expect(found.map((f) => f.number)).toEqual([1]);
  });

  it('follows Link-header pagination across pages (capped)', async () => {
    const page1 = res([{ number: 1, html_url: 'u1', title: 't1', body: 'stamp:v1' }], {
      headers: { Link: '<https://api.github.com/repos/o/r/issues?state=open&per_page=100&page=2>; rel="next"' },
    });
    const page2 = res([{ number: 2, html_url: 'u2', title: 't2', body: 'stamp:v1' }]);
    const fetchImpl = vi.fn(async (url: string) => (url.includes('page=2') ? page2 : page1));
    const c = clientWith(fetchImpl as unknown as typeof fetch);
    const found = await c.listStampIssues('o', 'r', 'stamp:v1');
    expect(found.map((f) => f.number)).toEqual([1, 2]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('caps pagination at maxPages even if next keeps pointing forward', async () => {
    const fetchImpl = vi.fn(async () =>
      res([{ number: 9, html_url: 'u', title: 't', body: 'stamp:v1' }], {
        headers: { Link: '<https://api.github.com/repos/o/r/issues?page=99>; rel="next"' },
      }),
    );
    const c = clientWith(fetchImpl as unknown as typeof fetch);
    await c.listStampIssues('o', 'r', 'stamp:v1', undefined, 2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('filters by a match predicate (only issues for the current doc)', async () => {
    const fetchImpl = vi.fn(async () =>
      res([
        { number: 1, html_url: 'u1', title: 't1', body: 'stamp:v1 docUrl=acme/coffee-qa/QA' },
        { number: 2, html_url: 'u2', title: 't2', body: 'stamp:v1 docUrl=other/repo/QB' },
      ]),
    );
    const c = clientWith(fetchImpl as unknown as typeof fetch);
    const found = await c.listStampIssues('o', 'r', 'stamp:v1', (b) => b.includes('acme/coffee-qa/QA'));
    expect(found.map((f) => f.number)).toEqual([1]);
  });
});

describe('getRawFile path encoding', () => {
  it('percent-encodes each path segment but preserves the slashes', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => res(null, { text: '# file' }));
    const c = clientWith(fetchImpl as unknown as typeof fetch);
    await c.getRawFile('o', 'r', 'QA/01 Brew & Steam/README.md', 'sha9');
    const url = String(fetchImpl.mock.calls[0][0]);
    expect(url).toContain('/contents/QA/01%20Brew%20%26%20Steam/README.md?ref=sha9');
    // negative: the space/ampersand are NOT left raw
    expect(url).not.toContain('Brew & Steam');
  });

  it('requests the raw media type', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => res(null, { text: 'x' }));
    const c = clientWith(fetchImpl as unknown as typeof fetch);
    await c.getRawFile('o', 'r', 'a.md', 'sha');
    const headers = (fetchImpl.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Accept).toBe('application/vnd.github.raw+json');
  });
});

describe('GithubClient error mapping', () => {
  const cases: Array<[string, Parameters<typeof res>[1], RegExp]> = [
    ['401 -> token invalid', { status: 401 }, /invalid or missing scope/i],
    ['403 (non-rate-limit) -> token invalid', { status: 403, headers: { 'x-ratelimit-remaining': '55' } }, /invalid or missing scope/i],
    ['403 rate-limit -> rate limit hint', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }, /rate limit/i],
    ['404 -> not found / no access', { status: 404 }, /not found/i],
  ];
  for (const [name, init, re] of cases) {
    it(name, async () => {
      const fetchImpl = vi.fn(async () => res({ message: 'x' }, init));
      const c = clientWith(fetchImpl as unknown as typeof fetch);
      await expect(c.getDefaultBranch('o', 'r')).rejects.toThrow(re);
    });
  }

  it('surfaces a generic API error with the server message', async () => {
    const fetchImpl = vi.fn(async () => res({ message: 'validation failed' }, { status: 422 }));
    const c = clientWith(fetchImpl as unknown as typeof fetch);
    await expect(c.createIssue('o', 'r', 't', 'b')).rejects.toThrow(/422: validation failed/);
  });

  it('maps a network reject to a clean error', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });
    const c = clientWith(fetchImpl as unknown as typeof fetch);
    await expect(c.resolveCommitSha('o', 'r', 'main')).rejects.toThrow(/Network error contacting GitHub/);
  });

  it('surfaces malformed JSON on a non-ok body without crashing the mapper', async () => {
    const bad = {
      ok: false,
      status: 500,
      headers: new Headers(),
      json: async () => {
        throw new Error('not json');
      },
      text: async () => 'oops',
    } as unknown as Response;
    const fetchImpl = vi.fn(async () => bad);
    const c = clientWith(fetchImpl as unknown as typeof fetch);
    await expect(c.getDefaultBranch('o', 'r')).rejects.toThrow(GithubError);
  });
});

describe('loadRunDoc (end-to-end over injected fetch)', () => {
  it('pins the run to a SHA and builds the doc from fetched markdown', async () => {
    const tree = {
      tree: [
        { path: 'QA/README.md', type: 'blob' },
        { path: 'QA/01_Brewing/README.md', type: 'blob' },
        { path: 'QA/logo.png', type: 'blob' },
        { path: 'other/thing.md', type: 'blob' },
      ],
    };
    const fetchImpl = vi.fn(async (url: string) => {
      if (/\/repos\/[^/]+\/[^/]+$/.test(url)) return res({ default_branch: 'main' });
      if (url.includes('/commits/')) return res({ sha: 'sha42' });
      if (url.includes('/git/trees/')) return res(tree);
      if (url.includes('QA/README.md')) return res(null, { text: '# Coffee QA\n\nOverview.' });
      if (url.includes('QA/01_Brewing/README.md'))
        return res(null, { text: '# 1. Brewing [BLOCKING]\n\n- [ ] **Power on.** Flip it.' });
      throw new Error(`unexpected url ${url}`);
    });
    const c = clientWith(fetchImpl as unknown as typeof fetch);
    const doc = await loadRunDoc(c, parseSourceUrl('acme/coffee-qa/QA'));
    expect(doc.source.sha).toBe('sha42');
    expect(doc.preamble).toContain('Overview');
    expect(doc.phases).toHaveLength(1);
    expect(doc.phases[0].title).toBe('1. Brewing');
    // logo.png and out-of-path files are ignored
    expect(fetchImpl.mock.calls.some((c) => String(c[0]).includes('logo.png'))).toBe(false);
    expect(fetchImpl.mock.calls.some((c) => String(c[0]).includes('other/thing.md'))).toBe(false);
  });

  it('errors clearly when the path has no markdown', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (/\/repos\/[^/]+\/[^/]+$/.test(url)) return res({ default_branch: 'main' });
      if (url.includes('/commits/')) return res({ sha: 's' });
      if (url.includes('/git/trees/')) return res({ tree: [{ path: 'src/main.go', type: 'blob' }] });
      throw new Error('unexpected');
    });
    const c = clientWith(fetchImpl as unknown as typeof fetch);
    await expect(loadRunDoc(c, parseSourceUrl('o/r/QA'))).rejects.toThrow(/No markdown files/);
  });
});
