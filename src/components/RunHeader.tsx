import type { RunDoc } from '../lib/types';
import type { RunSummary } from '../lib/state';
import { ProgressBar, CountsRow } from './ProgressBar';

interface Props {
  doc: RunDoc;
  summary: RunSummary;
  issueUrl?: string;
  onSettings: () => void;
  onFinish: () => void;
}

export function RunHeader({ doc, summary, issueUrl, onSettings, onFinish }: Props) {
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
      <div class="row" style={{ justifyContent: 'space-between' }}>
        <div class="row" style={{ gap: '10px' }}>
          <button onClick={onSettings} title="Change settings" aria-label="Change settings">
            ⚙︎
          </button>
          {issueUrl && (
            <a href={issueUrl} target="qa-docs" rel="noopener noreferrer" class="muted" style={{ fontSize: '12.5px' }}>
              issue ↗
            </a>
          )}
          {!issueUrl && <span class="muted" style={{ fontSize: '12.5px' }}>local only</span>}
        </div>
        <button onClick={onFinish}>Finish ▸</button>
      </div>
    </header>
  );
}
