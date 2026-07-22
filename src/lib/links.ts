// links.ts — classify and rewrite links in rendered step markdown.
//
// - links to the configured app host  -> one reusable named tab "qa-app"
// - other absolute http(s) links      -> "qa-docs" tab
// - relative links / #anchors         -> rewritten to the pinned GitHub blob,
//                                         opened in "qa-docs"
// The pure helpers below are unit-tested; rewriteLinks applies them to a DOM.

export const APP_TAB = 'qa-app';
export const DOCS_TAB = 'qa-docs';

export interface LinkContext {
  appHost?: string;
  owner: string;
  repo: string;
  sha: string;
  /** Repo path of the file this markdown came from (for relative resolution). */
  filePath: string;
}

const dirname = (p: string): string => {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
};

/** POSIX-style path join+normalize for repo-relative resolution. */
export function resolvePath(baseDir: string, rel: string): string {
  const fromRoot = rel.startsWith('/');
  const base = fromRoot ? [] : baseDir.split('/').filter(Boolean);
  const parts = rel.replace(/^\/+/, '').split('/');
  const out = [...base];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

/** URL.host — includes the port — so `localhost:5173` matches an app host with a port. */
function hostOf(href: string): string | undefined {
  try {
    return new URL(href).host || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Normalize a user-entered app host to a bare `host[:port]`: drop any scheme,
 * path, and trailing slash, and lowercase it so comparison against URL.host is
 * stable. `https://localhost:5173/app/` -> `localhost:5173`.
 */
export function normalizeAppHost(input: string | undefined): string {
  if (!input) return '';
  return input
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '') // scheme://
    .replace(/\/.*$/, '') // path and everything after
    .replace(/\/+$/, '')
    .toLowerCase();
}

/**
 * Resolve one href against the source file. Returns the final href and which
 * reusable tab it should open in. Absolute links keep their href; relative
 * links and bare anchors are rewritten to the pinned GitHub blob URL.
 */
export function resolveLink(href: string, ctx: LinkContext): { href: string; tab: string } | null {
  if (!href) return null;
  // Leave in-page/protocol links (mailto:, javascript: already stripped) alone.
  if (/^(mailto:|tel:)/i.test(href)) return { href, tab: DOCS_TAB };

  // Protocol-relative (//host/x) is an absolute link, not a repo-relative path.
  const candidate = href.startsWith('//') ? `https:${href}` : href;
  const host = hostOf(candidate);
  if (host) {
    // Absolute http(s) link (host includes the port).
    const appHost = normalizeAppHost(ctx.appHost);
    if (appHost && host.toLowerCase() === appHost) return { href: candidate, tab: APP_TAB };
    return { href: candidate, tab: DOCS_TAB };
  }

  // Relative link or bare anchor -> GitHub blob at the pinned SHA.
  const blobBase = `https://github.com/${ctx.owner}/${ctx.repo}/blob/${ctx.sha}`;
  if (href.startsWith('#')) {
    return { href: `${blobBase}/${ctx.filePath}${href}`, tab: DOCS_TAB };
  }
  const [pathPart, anchor] = href.split('#');
  const resolved = resolvePath(dirname(ctx.filePath), pathPart);
  return { href: `${blobBase}/${resolved}${anchor ? '#' + anchor : ''}`, tab: DOCS_TAB };
}

/** Apply link resolution + safe rel to every <a> under `root`. */
export function rewriteLinks(root: ParentNode, ctx: LinkContext): void {
  for (const a of Array.from(root.querySelectorAll('a[href]'))) {
    const anchor = a as HTMLAnchorElement;
    const resolved = resolveLink(anchor.getAttribute('href') ?? '', ctx);
    if (!resolved) continue;
    anchor.setAttribute('href', resolved.href);
    anchor.setAttribute('target', resolved.tab);
    anchor.setAttribute('rel', 'noopener noreferrer');
  }
}

/**
 * Suggest an app host: the most frequent absolute http(s) host across the doc.
 * Used to pre-fill the SetupScreen "app host" field.
 */
export function suggestAppHost(markdown: string): string | undefined {
  const counts = new Map<string, number>();
  const re = /https?:\/\/([^/\s)"'<>]+)/gi;
  for (const m of markdown.matchAll(re)) {
    const host = m[1].toLowerCase();
    if (host === 'github.com' || host === 'api.github.com') continue;
    counts.set(host, (counts.get(host) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestN = 0;
  for (const [host, n] of counts) {
    if (n > bestN) {
      best = host;
      bestN = n;
    }
  }
  return best;
}
