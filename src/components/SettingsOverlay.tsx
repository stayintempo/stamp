import { useState } from 'preact/hooks';
import type { Settings } from '../lib/state';

interface Props {
  initial: Settings;
  /** The checklist URL the current run is loaded from. */
  currentUrl: string;
  busy: boolean;
  /** Apply token/appHost in place without ending the run. */
  onApplyInPlace: (s: Settings) => void;
  /** Load a different checklist (ends the current run). */
  onReconnect: (s: Settings) => void;
  onClearToken: () => void;
  onCancel: () => void;
}

/**
 * In-run settings, opened as a cancelable overlay that PRESERVES the run.
 * Cancel returns untouched. Saving token/appHost applies in place. Changing the
 * checklist URL warns that it ends the current run and requires confirmation
 * (H5). Avoids the old behavior where the gear dropped back to the connect flow
 * and invited a duplicate issue.
 */
export function SettingsOverlay({
  initial,
  currentUrl,
  busy,
  onApplyInPlace,
  onReconnect,
  onClearToken,
  onCancel,
}: Props) {
  const [githubUrl, setGithubUrl] = useState(initial.githubUrl);
  const [token, setToken] = useState(initial.token);
  const [appHost, setAppHost] = useState(initial.appHost);
  const [confirmReconnect, setConfirmReconnect] = useState(false);

  const urlChanged = githubUrl.trim() !== currentUrl.trim();

  const submit = (e: Event) => {
    e.preventDefault();
    const s: Settings = { githubUrl: githubUrl.trim(), token: token.trim(), appHost: appHost.trim() };
    if (!urlChanged) {
      onApplyInPlace(s);
      return;
    }
    if (!confirmReconnect) {
      setConfirmReconnect(true);
      return;
    }
    onReconnect(s);
  };

  return (
    <div class="overlay" role="dialog" aria-modal="true" aria-label="Settings">
      <section class="overlay-panel pad stack">
        <div class="row" style={{ justifyContent: 'space-between' }}>
          <strong>Settings</strong>
          <button type="button" onClick={onCancel} aria-label="Close settings">
            ✕
          </button>
        </div>

        <form class="stack" onSubmit={submit}>
          <div class="field">
            <label for="s-gh">Checklist location</label>
            <input
              id="s-gh"
              value={githubUrl}
              onInput={(e) => {
                setGithubUrl((e.target as HTMLInputElement).value);
                setConfirmReconnect(false);
              }}
              required
            />
            {urlChanged && (
              <p class="hint warn">
                Changing the checklist ends the current run and starts over.
              </p>
            )}
          </div>

          <div class="field">
            <label for="s-pat">Personal access token</label>
            <input
              id="s-pat"
              type="password"
              value={token}
              onInput={(e) => setToken((e.target as HTMLInputElement).value)}
              placeholder="github_pat_…"
              autocomplete="off"
            />
            {token && (
              <button
                type="button"
                class="linkish"
                onClick={() => {
                  setToken('');
                  onClearToken();
                }}
              >
                Clear stored token
              </button>
            )}
          </div>

          <div class="field">
            <label for="s-host">App host under test</label>
            <input
              id="s-host"
              value={appHost}
              onInput={(e) => setAppHost((e.target as HTMLInputElement).value)}
              placeholder="app.example.com"
            />
          </div>

          <div class="row" style={{ justifyContent: 'flex-end', gap: '8px' }}>
            <button type="button" onClick={onCancel}>
              Cancel
            </button>
            <button class="primary" type="submit" disabled={busy}>
              {urlChanged ? (confirmReconnect ? 'End run & reload' : 'Change checklist…') : 'Save'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
