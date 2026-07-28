import { useState } from 'preact/hooks';
import type { Settings } from '../lib/state';

interface Props {
  initial: Settings;
  busy: boolean;
  error?: string;
  onConnect: (s: Settings) => void;
  /** Clears the stored token (localStorage) and the field. */
  onClearToken?: () => void;
}

const PAT_URL = 'https://github.com/settings/personal-access-tokens/new';

export function SetupScreen({ initial, busy, error, onConnect, onClearToken }: Props) {
  const [githubUrl, setGithubUrl] = useState(initial.githubUrl);
  const [token, setToken] = useState(initial.token);
  const [appHost, setAppHost] = useState(initial.appHost);
  const [reducedMode, setReducedMode] = useState(!!initial.reducedMode);

  const clearToken = () => {
    setToken('');
    onClearToken?.();
  };

  return (
    <section class="pad stack">
      <div>
        <div class="brand" style={{ fontSize: '22px' }}>STAMP</div>
        <div class="tagline">Sign-off Tracker for Acceptance &amp; Manual Passes</div>
      </div>

      <p class="hint">
        Point STAMP at a markdown QA checklist in a GitHub repo. It walks you through it one step at a time and syncs
        progress to a GitHub issue.
      </p>

      {error && <div class="error">{error}</div>}

      <form
        class="stack"
        onSubmit={(e) => {
          e.preventDefault();
          onConnect({ githubUrl: githubUrl.trim(), token: token.trim(), appHost: appHost.trim(), reducedMode });
        }}
      >
        <div class="field">
          <label for="gh">Checklist location</label>
          <input
            id="gh"
            value={githubUrl}
            onInput={(e) => setGithubUrl((e.target as HTMLInputElement).value)}
            placeholder="owner/repo/QA@v1.2.0  or a github.com tree/blob URL"
            required
          />
          <p class="hint">
            A repo path, a github.com tree/blob URL, or bare owner/repo. On the repo-path form, add{' '}
            <code>@ref</code> to pin the run: <code>owner/repo/QA@v1.2.0</code> for a tag, <code>@a1b2c3d</code> for a
            commit, <code>@fix/my-branch</code> for a branch. Without <code>@ref</code> the run follows the default
            branch, which can change under you mid-pass.
          </p>
        </div>

        <div class="field">
          <label for="pat">Personal access token (optional for public repos)</label>
          <input
            id="pat"
            type="password"
            value={token}
            onInput={(e) => setToken((e.target as HTMLInputElement).value)}
            placeholder="github_pat_…"
            autocomplete="off"
          />
          <p class="hint">
            Stored only in this browser. Create a{' '}
            <a href={PAT_URL} target="qa-docs" referrerpolicy="no-referrer">
              fine-grained token
            </a>{' '}
            scoped to the single repo with <strong>Contents: read-only</strong> and{' '}
            <strong>Issues: read and write</strong>.
          </p>
          {token && (
            <button type="button" class="linkish" onClick={clearToken}>
              Clear stored token
            </button>
          )}
        </div>

        <div class="field">
          <label for="host">App host under test</label>
          <input
            id="host"
            value={appHost}
            onInput={(e) => setAppHost((e.target as HTMLInputElement).value)}
            placeholder="app.example.com"
          />
          <p class="hint">Links to this host open in one reusable tab beside STAMP. Auto-suggested from the doc.</p>
        </div>

        <div class="field">
          <label class="row" style={{ gap: '8px', alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={reducedMode}
              onChange={(e) => setReducedMode((e.target as HTMLInputElement).checked)}
            />
            Reduced run: auto-skip machine-covered steps
          </label>
          <p class="hint">
            When the checklist ships a <code>COVERAGE.md</code> ledger, boxes tagged CI or SEED start
            auto-skipped. You can un-skip any of them.
          </p>
        </div>

        <button class="primary" type="submit" disabled={busy}>
          {busy ? 'Loading…' : 'Connect & load checklist'}
        </button>
      </form>
    </section>
  );
}
