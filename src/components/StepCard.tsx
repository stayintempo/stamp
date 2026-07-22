import { useState } from 'preact/hooks';
import type { Phase, Step } from '../lib/types';
import type { StepStatus } from '../lib/state';
import { screenshotReference } from '../lib/state';
import { type LinkContext } from '../lib/links';
import { Markdown } from './Markdown';
import { FailNoteDialog } from './FailNoteDialog';

interface Props {
  phase: Phase;
  step: Step;
  positionText: string;
  status: StepStatus;
  note?: string;
  linkCtx: LinkContext;
  issueUrl?: string;
  /** Phase intro prose, shown on the first step of a phase. */
  phaseIntro?: string;
  /** Group (per-file) intro prose, shown on the first step of a group. */
  groupIntro?: string;
  hasBack: boolean;
  hasNext: boolean;
  /**
   * Note-editor visibility. Owned by App, not here: it is one of the modal
   * flags that gate the run screen's single keyboard listener, and that
   * decision has to live in one place. See App's `modalOpen`.
   */
  noteOpen: boolean;
  onOpenNote: () => void;
  onCloseNote: () => void;
  onVerdict: (status: StepStatus) => void;
  onNote: (note: string) => void;
  onBack: () => void;
  onNext: () => void;
}

export function StepCard(props: Props) {
  const { phase, step, status, note, linkCtx, issueUrl } = props;
  const [copied, setCopied] = useState(false);

  const copyScreenshotRef = async () => {
    const ref = screenshotReference(phase.title, step);
    try {
      await navigator.clipboard.writeText(ref);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard may be unavailable; the issue tab still opens */
    }
    if (issueUrl) window.open(issueUrl, 'qa-docs');
  };

  return (
    <section class="stepcard">
      <div class="pos">
        <span>{props.positionText}</span>
        {phase.badge && (
          <span class={`badge ${phase.badge.toLowerCase()}`}>{phase.badge}</span>
        )}
        <span class={`statusline ${status}`}>{statusText(status)}</span>
      </div>

      {props.phaseIntro && (
        <details class="intro" open>
          <summary>Phase notes</summary>
          <Markdown markdown={props.phaseIntro} ctx={linkCtx} />
        </details>
      )}
      {props.groupIntro && (
        <details class="intro" open>
          <summary>Section notes</summary>
          <Markdown markdown={props.groupIntro} ctx={linkCtx} />
        </details>
      )}

      {step.separatorBefore && <Markdown markdown={step.separatorBefore} ctx={linkCtx} class="sep" />}

      <Markdown markdown={step.bodyMarkdown} ctx={linkCtx} />

      {step.separatorAfter && <Markdown markdown={step.separatorAfter} ctx={linkCtx} class="sep" />}

      <div class="verdict">
        <button class={`pass ${status === 'pass' ? 'active' : ''}`} onClick={() => props.onVerdict('pass')}>
          ✓ Pass
        </button>
        <button class={`fail ${status === 'fail' ? 'active' : ''}`} onClick={() => props.onVerdict('fail')}>
          ✕ Fail
        </button>
        <button class={`skip ${status === 'skip' ? 'active' : ''}`} onClick={() => props.onVerdict('skip')}>
          ⏭ Skip
        </button>
      </div>

      <div class="note-tools row" style={{ justifyContent: 'space-between' }}>
        <button class="linkish" onClick={props.onOpenNote}>
          {note ? '📝 Edit note' : '＋ Add note'}
        </button>
        {issueUrl && (
          <button class="linkish" onClick={copyScreenshotRef} title="Copies a reference line and opens the issue">
            {copied ? '✓ copied — paste in a comment' : '📎 Attach screenshot via issue'}
          </button>
        )}
      </div>
      {note && <p class="hint">Note: {note}</p>}

      <div class="nav-btns">
        <button onClick={props.onBack} disabled={!props.hasBack}>
          ◂ Back
        </button>
        <button onClick={props.onNext} disabled={!props.hasNext}>
          Next ▸
        </button>
      </div>

      <FailNoteDialog
        open={props.noteOpen}
        title={status === 'fail' ? 'Note the failure' : 'Step note'}
        hint={status === 'fail' ? 'A note is encouraged so the failure is actionable.' : undefined}
        initial={note ?? ''}
        onSave={(n) => {
          props.onNote(n);
          props.onCloseNote();
        }}
        onClose={props.onCloseNote}
      />
    </section>
  );
}

function statusText(s: StepStatus): string {
  switch (s) {
    case 'pass':
      return '✓ Passed';
    case 'fail':
      return '✕ Failed';
    case 'skip':
      return '⏭ Skipped';
    default:
      return 'Pending';
  }
}
