import type { RunDoc } from '../lib/types';
import type { RunSummary } from '../lib/state';
import { ProgressBar, CountsRow } from './ProgressBar';

export type SyncStatus = 'idle' | 'pending' | 'synced' | 'error';

interface Props {
  doc: RunDoc;
  summary: RunSummary;
  issueUrl?: string;
  /** Only shown when an issue is active (not local-only). */
  syncStatus?: SyncStatus;
  /** Count of doc steps not reflected in the issue body (hand-deleted lines). */
  syncNotice?: number;
  /** Where the run currently is; absent only if the doc has no steps. */
  phase?: { number: number; count: number; title: string };
  phasesOpen: boolean;
  onOpenPhases: () => void;
  onRetrySync?: () => void;
  onSettings: () => void;
  onFinish: () => void;
}

function SyncIndicator({
  status,
  notice,
  onRetry,
}: {
  status: SyncStatus;
  notice: number;
  onRetry?: () => void;
}) {
  if (status === 'error') {
    return (
      <span class="sync error">
        ⚠ sync failed{' '}
        <button class="linkish" onClick={onRetry} title="Retry syncing to the issue now">
          Retry
        </button>
      </span>
    );
  }
  const text =
    status === 'pending' ? 'syncing…' : status === 'synced' ? '✓ synced' : 'not synced';
  return (
    <span class={`sync ${status}`}>
      {text}
      {notice > 0 && (
        <span class="sync-notice" title="Steps whose task line is missing from the issue body">
          {' '}· {notice} not in issue
        </span>
      )}
    </span>
  );
}

export function RunHeader({
  doc,
  summary,
  issueUrl,
  syncStatus,
  syncNotice,
  phase,
  phasesOpen,
  onOpenPhases,
  onRetrySync,
  onSettings,
  onFinish,
}: Props) {
  return (
    <header class="runheader stack">
      <div class="title">
        <span>
          {doc.source.owner}/{doc.source.repo}
          {doc.source.path ? ` · ${doc.source.path}` : ''}
        </span>
        <span class="sha" title={doc.source.sha}>
          {doc.source.ref}@{doc.source.sha.slice(0, 7)}
        </span>
      </div>
      <ProgressBar counts={summary.totals} />
      <CountsRow counts={summary.totals} />
      {phase && (
        <button
          class="phase-pick"
          onClick={onOpenPhases}
          aria-haspopup="dialog"
          aria-expanded={phasesOpen}
          title="Jump to another phase or step"
        >
          <span class="pp-pos">
            Phase {phase.number}/{phase.count}
          </span>
          <span class="pp-title">{phase.title}</span>
          <span class="pp-caret" aria-hidden="true">
            ▾
          </span>
        </button>
      )}
      <div class="row" style={{ justifyContent: 'space-between' }}>
        <div class="row" style={{ gap: '10px' }}>
          <button onClick={onSettings} title="Change settings" aria-label="Change settings">
            ⚙︎
          </button>
          {issueUrl && (
            <a href={issueUrl} target="qa-docs" referrerpolicy="no-referrer" class="muted" style={{ fontSize: '12.5px' }}>
              issue ↗
            </a>
          )}
          {issueUrl && syncStatus && (
            <SyncIndicator status={syncStatus} notice={syncNotice ?? 0} onRetry={onRetrySync} />
          )}
          {!issueUrl && <span class="muted" style={{ fontSize: '12.5px' }}>local only</span>}
        </div>
        <button onClick={onFinish}>Finish ▸</button>
      </div>
    </header>
  );
}
