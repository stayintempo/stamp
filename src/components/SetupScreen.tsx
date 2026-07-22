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
          onConnect({ githubUrl: githubUrl.trim(), token: token.trim(), appHost: appHost.trim() });
        }}
      >
        <div class="field">
          <label for="gh">Checklist location</label>
          <input
            id="gh"
            value={githubUrl}
            onInput={(e) => setGithubUrl((e.target as HTMLInputElement).value)}
            placeholder="owner/repo/QA  or a github.com tree/blob URL"
            required
          />
          <p class="hint">A repo path, a github.com tree/blob URL, or bare owner/repo.</p>
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

        <button class="primary" type="submit" disabled={busy}>
          {busy ? 'Loading…' : 'Connect & load checklist'}
        </button>
      </form>
    </section>
  );
}
