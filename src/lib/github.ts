// github.ts — thin GitHub REST client + source-URL resolution.
//
// Kept injectable (pass a `fetch` impl) so tests never touch the network.
// Everything network-touching lives here; parse.ts stays pure.

import type { RunDoc, Source, SourceFile } from './types';
import { buildRunDoc } from './parse';

export interface ParsedUrl {
  owner: string;
  repo: string;
  /** undefined = use the repo default branch */
  ref?: string;
  /** '' = repo root */
  path: string;
  kind: 'tree' | 'blob' | 'bare';
}

export class GithubError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'GithubError';
    this.status = status;
  }
}

const OWNER_REPO = /^[A-Za-z0-9._-]+$/;

/**
 * Accepts:
 *   https://github.com/{o}/{r}/tree/{ref}/{path...}
 *   https://github.com/{o}/{r}/blob/{ref}/{path}.md
 *   https://github.com/{o}/{r}[/{path...}]
 *   {o}/{r}[/{path...}]              (bare, default branch)
 * Rejects any non-github.com URL.
 *
 * NOTE: for tree/blob URLs the ref is taken as the first path segment; branch
 * names containing '/' are not resolvable from the URL alone — use the bare
 * form with the ref selected as the default branch, or a tag/sha.
 */
export function parseSourceUrl(input: string): ParsedUrl {
  const raw = input.trim();
  if (!raw) throw new GithubError('Enter a GitHub URL or owner/repo.');

  if (/^https?:\/\//i.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new GithubError('That does not look like a valid URL.');
    }
    if (url.hostname !== 'github.com') {
      throw new GithubError('Only github.com URLs are supported.');
    }
    const segs = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (segs.length < 2) throw new GithubError('URL must include owner and repo.');
    const owner = segs[0];
    const repo = segs[1].replace(/\.git$/, '');
    const marker = segs[2];
    if (marker === 'tree' || marker === 'blob') {
      const ref = segs[3];
      if (!ref) throw new GithubError(`URL is missing a ref after /${marker}/.`);
      const path = segs.slice(4).join('/');
      return { owner, repo, ref, path, kind: marker };
    }
    // bare repo URL, optional path (no ref in URL)
    return { owner, repo, path: segs.slice(2).join('/'), kind: 'bare' };
  }

  // bare owner/repo[/path]
  const segs = raw.replace(/^\/+|\/+$/g, '').split('/');
  if (segs.length < 2 || !OWNER_REPO.test(segs[0]) || !OWNER_REPO.test(segs[1])) {
    throw new GithubError('Enter a github.com URL or "owner/repo".');
  }
  return { owner: segs[0], repo: segs[1].replace(/\.git$/, ''), path: segs.slice(2).join('/'), kind: 'bare' };
}

export interface GithubClientOptions {
  token?: string;
  fetchImpl?: typeof fetch;
  apiBase?: string;
}

interface TreeEntry {
  path: string;
  type: string;
}

export interface IssueRef {
  number: number;
  htmlUrl: string;
  title: string;
  body: string;
}

export class GithubClient {
  private token?: string;
  private fetchImpl: typeof fetch;
  private apiBase: string;

  constructor(opts: GithubClientOptions = {}) {
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.apiBase = opts.apiBase ?? 'https://api.github.com';
  }

  private headers(accept = 'application/vnd.github+json'): HeadersInit {
    const h: Record<string, string> = {
      Accept: accept,
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }

  private async request(path: string, init?: RequestInit, accept?: string): Promise<Response> {
    const url = path.startsWith('http') ? path : `${this.apiBase}${path}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, { ...init, headers: { ...this.headers(accept), ...(init?.headers ?? {}) } });
    } catch (e) {
      throw new GithubError(`Network error contacting GitHub: ${(e as Error).message}`);
    }
    if (!res.ok) throw await this.toError(res);
    return res;
  }

  private async toError(res: Response): Promise<GithubError> {
    if (res.status === 401 || res.status === 403) {
      const remaining = res.headers.get('x-ratelimit-remaining');
      if (remaining === '0') {
        return new GithubError('GitHub API rate limit reached — add a token or wait a few minutes.', res.status);
      }
      return new GithubError('Token invalid or missing scope (need Contents: read, Issues: read+write).', res.status);
    }
    if (res.status === 404) return new GithubError('Not found, or the token has no access to this repo.', 404);
    let detail = '';
    try {
      detail = ((await res.json()) as { message?: string }).message ?? '';
    } catch {
      /* ignore */
    }
    return new GithubError(`GitHub API error ${res.status}${detail ? `: ${detail}` : ''}`, res.status);
  }

  async getDefaultBranch(owner: string, repo: string): Promise<string> {
    const res = await this.request(`/repos/${owner}/${repo}`);
    return ((await res.json()) as { default_branch: string }).default_branch;
  }

  /** Resolve a symbolic ref (branch/tag/sha) to a full commit SHA. */
  async resolveCommitSha(owner: string, repo: string, ref: string): Promise<string> {
    const res = await this.request(`/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`);
    return ((await res.json()) as { sha: string }).sha;
  }

  async listTree(owner: string, repo: string, sha: string): Promise<TreeEntry[]> {
    const res = await this.request(`/repos/${owner}/${repo}/git/trees/${sha}?recursive=1`);
    const data = (await res.json()) as { tree: TreeEntry[]; truncated?: boolean };
    if (data.truncated) {
      throw new GithubError('Repository tree is too large to list in one request (truncated).');
    }
    return data.tree;
  }

  async getRawFile(owner: string, repo: string, path: string, sha: string): Promise<string> {
    const res = await this.request(
      `/repos/${owner}/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${sha}`,
      undefined,
      'application/vnd.github.raw+json',
    );
    return res.text();
  }

  async createIssue(owner: string, repo: string, title: string, body: string): Promise<IssueRef> {
    const res = await this.request(`/repos/${owner}/${repo}/issues`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body }),
    });
    return this.toIssueRef(await res.json());
  }

  async getIssue(owner: string, repo: string, num: number): Promise<IssueRef> {
    const res = await this.request(`/repos/${owner}/${repo}/issues/${num}`);
    return this.toIssueRef(await res.json());
  }

  async updateIssueBody(owner: string, repo: string, num: number, body: string): Promise<IssueRef> {
    const res = await this.request(`/repos/${owner}/${repo}/issues/${num}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    });
    return this.toIssueRef(await res.json());
  }

  async addComment(owner: string, repo: string, num: number, body: string): Promise<void> {
    await this.request(`/repos/${owner}/${repo}/issues/${num}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    });
  }

  /** Open issues in the repo whose body carries the STAMP marker. */
  async listStampIssues(owner: string, repo: string, marker: string): Promise<IssueRef[]> {
    const res = await this.request(`/repos/${owner}/${repo}/issues?state=open&per_page=100`);
    const rows = (await res.json()) as Array<Record<string, unknown>>;
    return rows
      .filter((r) => typeof r.body === 'string' && (r.body as string).includes(marker))
      .filter((r) => !('pull_request' in r))
      .map((r) => this.toIssueRef(r));
  }

  private toIssueRef(r: unknown): IssueRef {
    const o = r as { number: number; html_url: string; title: string; body: string | null };
    return { number: o.number, htmlUrl: o.html_url, title: o.title, body: o.body ?? '' };
  }
}

/**
 * Resolve a parsed URL to a pinned Source and fetch every `.md` under its path,
 * then build the RunDoc. One tree call + one fetch per file.
 */
export async function loadRunDoc(client: GithubClient, parsed: ParsedUrl): Promise<RunDoc> {
  const { owner, repo } = parsed;
  const ref = parsed.ref ?? (await client.getDefaultBranch(owner, repo));
  const sha = await client.resolveCommitSha(owner, repo, ref);
  const path = parsed.path.replace(/^\/+|\/+$/g, '');

  const tree = await client.listTree(owner, repo, sha);
  const prefix = path ? path + '/' : '';
  const mdPaths = tree
    .filter((e) => e.type === 'blob' && /\.md$/i.test(e.path))
    .map((e) => e.path)
    .filter((p) => (path === '' ? true : p === path || p.startsWith(prefix)));

  if (mdPaths.length === 0) {
    throw new GithubError(`No markdown files found under "${path || '/'}".`);
  }

  const files: SourceFile[] = await Promise.all(
    mdPaths.map(async (p) => ({ path: p, content: await client.getRawFile(owner, repo, p, sha) })),
  );

  const source: Source = { owner, repo, ref, sha, path };
  return buildRunDoc(source, files);
}
