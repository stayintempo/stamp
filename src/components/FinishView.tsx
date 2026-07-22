import { useState } from 'preact/hooks';
import type { RunDoc } from '../lib/types';
import type { RunState, RunSummary } from '../lib/state';
import { ProgressBar } from './ProgressBar';

interface Props {
  doc: RunDoc;
  state: RunState;
  summary: RunSummary;
  issueUrl?: string;
  /** Markdown mirror for the copy-to-clipboard (local-only) path. */
  mirror: string;
  posting: boolean;
  /** True once the summary comment has posted successfully. */
  posted?: boolean;
  postError?: string;
  onPostSummary: () => void;
  onBack: () => void;
}

export function FinishView({
  summary,
  issueUrl,
  mirror,
  posting,
  posted,
  postError,
  onPostSummary,
  onBack,
}: Props) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(mirror);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* ignore */
    }
  };

  return (
    <section class="pad stack">
      <h2 style={{ margin: 0 }}>Run summary</h2>

      {summary.blockingFailures > 0 ? (
        <div class="error">
          ✕ {summary.blockingFailures} blocking failure{summary.blockingFailures === 1 ? '' : 's'} — this run does not
          pass.
        </div>
      ) : summary.totals.fail > 0 ? (
        <div class="statusline fail">✕ {summary.totals.fail} failure(s), none in blocking phases</div>
      ) : summary.totals.pending > 0 ? (
        <div class="statusline pending">{summary.totals.pending} step(s) still pending</div>
      ) : (
        <div class="statusline pass">✓ All steps passed or skipped</div>
      )}

      <div class="stack">
        {summary.phases.map((p) => (
          <div key={p.id} class="stack" style={{ gap: '4px' }}>
            <div class="row" style={{ justifyContent: 'space-between' }}>
              <span style={{ fontWeight: 600, fontSize: '13.5px' }}>
                {p.title}{' '}
                {p.blocking && <span class="badge blocking">BLK</span>}
              </span>
              <span class="muted" style={{ fontSize: '12px' }}>
                {p.pass}✓ {p.fail}✕ {p.skip}⏭ {p.pending}·
              </span>
            </div>
            <ProgressBar counts={p} />
          </div>
        ))}
      </div>

      <div class="stack">
        {issueUrl ? (
          <>
            <button class="primary" onClick={onPostSummary} disabled={posting || posted}>
              {posting ? 'Posting…' : posted ? '✓ Summary posted' : 'Post summary comment to issue'}
            </button>
            {posted && <div class="statusline pass">Summary comment posted to the issue.</div>}
            {postError && <div class="error">Could not post summary: {postError}</div>}
            <a href={issueUrl} target="qa-docs" referrerpolicy="no-referrer">
              Open the run issue ↗
            </a>
          </>
        ) : (
          <button class="primary" onClick={copy}>
            {copied ? '✓ Copied' : 'Copy markdown summary to clipboard'}
          </button>
        )}
        <button onClick={onBack}>◂ Back to steps</button>
      </div>
    </section>
  );
}
