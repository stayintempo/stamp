# STAMP — Sign-off Tracker for Acceptance & Manual Passes

STAMP is a browser-only tool that walks a human tester through a markdown QA
checklist hosted in a GitHub repo, **one step at a time**, in a narrow window
(~400px) that sits beside the app under test. Each step is marked pass / fail /
skip with an optional note, and progress syncs to a **GitHub issue** that becomes
the shared, auditable record of the run.

It is a static single-page app (Vite + TypeScript + Preact). There is no backend:
the browser talks directly to the GitHub REST API. It deploys to GitHub Pages and
works under any repo name (the build uses a relative base).

> Screenshot placeholder — add `docs/screenshot.png` and reference it here.

## Why

Automated suites don't exercise the rendered UI, permission-gated navigation,
drag interactions, or third-party round-trips. Those get a human click-through.
STAMP keeps that pass moving and turns it into a durable, reviewable issue rather
than a checklist someone eyeballs and forgets.

## How it works

1. Paste a link to a checklist (a repo path, or a `github.com` tree/blob URL).
2. STAMP fetches the markdown at a **pinned commit SHA**, parses it into phases
   and steps, and shows one step at a time.
3. Start a run (creates a GitHub issue), resume an existing run, or run locally
   with no issue.
4. Mark each step. State is saved to `localStorage` immediately and pushed to the
   issue body (debounced) so the issue always mirrors your progress.
5. Finish: see per-phase totals, blocking failures called out, and post a summary
   comment to the issue.

Links inside a step open in **reusable named tabs**: links to the app host open
in one `qa-app` tab beside STAMP; everything else opens in a `qa-docs` tab.

## Checklist folder convention (the format contract)

STAMP treats an ordinary folder of markdown as a run. The rules:

### Where to point it

- **Tree URL:** `https://github.com/{owner}/{repo}/tree/{ref}/{path}` (path optional).
- **Blob URL:** `https://github.com/{owner}/{repo}/blob/{ref}/{path}.md`.
- **Bare:** `{owner}/{repo}` or `{owner}/{repo}/{path}` (defaults to the repo's
  default branch).

The whole run is pinned to the commit the ref resolves to, so it can't shift
under you mid-pass.

> Note: for `tree`/`blob` URLs the ref is the first path segment — branch names
> containing `/` aren't resolvable from the URL alone. Use the bare form (default
> branch) or a tag/SHA in that case.

### How structure maps to a run

- **A directory with subfolders** → each **subfolder is a phase**, run in natural
  sort order (numeric prefixes like `00_`, `01_`, `10_` set the order; `2` sorts
  before `10`). A root `README.md` in that directory becomes the run **overview**
  (a collapsible preamble). Other loose files at the root are ignored when
  subfolders exist.
- **Inside a phase folder:**
  - If it contains **numeric-prefixed `.md` files** (e.g. `01-login.md`), each of
    those files is a **step group**, sorted naturally. A `README.md` alongside
    them supplies the phase title and intro.
  - Otherwise, the folder's **`README.md` is the sole step group**.
- **A directory with no subfolders** → a single phase, applying the file rules
  above at that directory.
- **A blob URL to one `.md`** → a single phase with one step group.

### What a step is

- A step is a **top-level `- [ ]` list item.** Everything belonging to it
  (continuation lines, nested bullets, code blocks) is the step body.
- **Nested `- [ ]`** render inside the step card as a tester-local sub-checklist
  (toggleable, not tracked or persisted).
- A step's **label** is its first `**bold**` span, else its first sentence
  (truncated to ~80 chars).
- **`## / ###` headings** between steps render as visual separators, not tracked
  steps.
- A file with **no checkboxes** is itself a single step (the whole file is the
  body; its H1 or filename is the label).
- Checkboxes **inside fenced code blocks are ignored.**
- `- [x]` (pre-checked) items still parse as steps — the doc is a template, so
  every step starts pending.
- A phase title comes from the H1 of its first content file; a trailing
  `[BLOCKING]` / `[INFORMATIONAL]` tag becomes the phase badge. With no H1, the
  folder name is humanized (numeric prefix stripped, underscores → spaces).

See `test/fixtures.ts` for a small, fully synthetic example.

## Setup: create a token

Public repos work without a token. For private repos or issue sync you need a
GitHub **fine-grained personal access token**:

1. Go to <https://github.com/settings/personal-access-tokens/new>.
2. Scope it to the **single repository** that holds the checklist and issues.
3. Grant repository permissions:
   - **Contents: Read-only** (to fetch the checklist)
   - **Issues: Read and write** (to create and update the run issue)
4. Paste it into STAMP's token field. It is stored **only in your browser's
   `localStorage`** and sent only to `api.github.com`.

Use an app host of e.g. `app.example.com` — the host of the app you are testing —
so its links open in the reusable `qa-app` tab.

## Local development

```sh
npm install
npm run dev        # start the dev server
npm run typecheck  # tsc --noEmit
npm test           # vitest run
npm run build      # production build to dist/
```

## Deploy to GitHub Pages

Pushing to `main` runs `.github/workflows/deploy.yml`, which typechecks, tests,
builds, and publishes `dist/` with `actions/deploy-pages`. Enable Pages for the
repo with **Source: GitHub Actions**. The build uses `base: './'`, so it works at
any Pages path regardless of the repo name.

## Releases

Versioning is automated by **release-please** (`.github/workflows/release-please.yml`).
It reads [Conventional Commits](https://www.conventionalcommits.org/) on `main`
and opens a release PR that bumps the version and updates the changelog; merging
that PR cuts the release. Because releases are derived from commit messages,
**squash-merge titles must themselves be conventional** (`feat:`, `fix:`, …) or
the change is skipped. The running version is shown in the app footer and pinned
into each run issue's metadata (`"tool": "stamp@x.y.z"`).

## v1 limitations

- **One active tester per issue.** Issue-body sync is a last-writer merge that
  preserves foreign lines and hand edits, but concurrent testers on the same issue
  can clobber each other's latest write.
- **No inline screenshot upload.** GitHub has no public API for issue attachments,
  so STAMP instead offers "Attach screenshot via issue": it copies a reference
  line and opens the issue so you paste the image into a comment using GitHub's
  native attachment. True inline upload is a v2 item (would require Contents:
  write).
- **Single-year / single-file structural assumptions.** Deeply nested folders
  below a phase are not walked; only direct files of a phase folder are used.
- **Branch names with `/`** aren't resolvable from `tree`/`blob` URLs (see above).
- **Notes are single-line** in the issue mirror (multi-line notes are flattened to
  keep the round-trip stable).

## License

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 Jason Legate.
