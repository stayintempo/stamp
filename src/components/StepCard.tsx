import { useEffect, useRef, useState } from 'preact/hooks';
import type { Phase, Step } from '../lib/types';
import type { StepStatus } from '../lib/state';
import { screenshotReference } from '../lib/state';
import { renderMarkdown } from '../lib/markdown';
import { rewriteLinks, type LinkContext } from '../lib/links';
import { FailNoteDialog } from './FailNoteDialog';

interface Props {
  phase: Phase;
  step: Step;
  positionText: string;
  status: StepStatus;
  note?: string;
  linkCtx: LinkContext;
  issueUrl?: string;
  hasBack: boolean;
  hasNext: boolean;
  onVerdict: (status: StepStatus) => void;
  onNote: (note: string) => void;
  /** Called after the fail note dialog closes, to auto-advance. */
  onFailResolved: () => void;
  onBack: () => void;
  onNext: () => void;
}

/** Render markdown into `el` and finalize links (targets, rel, nested checkboxes). */
function useRenderedBody(markdown: string | undefined, ctx: LinkContext) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!markdown) {
      el.innerHTML = '';
      return;
    }
    el.innerHTML = renderMarkdown(markdown);
    rewriteLinks(el, ctx);
    // Nested checkboxes become tester-local, toggleable (state not persisted).
    el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((box) => {
      box.disabled = false;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markdown, ctx.filePath, ctx.sha, ctx.appHost]);
  return ref;
}

export function StepCard(props: Props) {
  const { phase, step, status, note, linkCtx, issueUrl } = props;
  const [dialogOpen, setDialogOpen] = useState(false);
  const [openedForFail, setOpenedForFail] = useState(false);
  const [copied, setCopied] = useState(false);

  const bodyRef = useRenderedBody(step.bodyMarkdown, linkCtx);
  const sepRef = useRenderedBody(step.separatorBefore, linkCtx);

  const verdict = (s: StepStatus) => {
    props.onVerdict(s);
    if (s === 'fail') {
      setOpenedForFail(true);
      setDialogOpen(true);
    }
  };

  const closeDialog = () => {
    setDialogOpen(false);
    if (openedForFail) {
      setOpenedForFail(false);
      props.onFailResolved();
    }
  };

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

      {step.separatorBefore && <div class="sep" ref={sepRef} />}

      <div class="body" ref={bodyRef} />

      <div class="verdict">
        <button class={`pass ${status === 'pass' ? 'active' : ''}`} onClick={() => verdict('pass')}>
          ✓ Pass
        </button>
        <button class={`fail ${status === 'fail' ? 'active' : ''}`} onClick={() => verdict('fail')}>
          ✕ Fail
        </button>
        <button class={`skip ${status === 'skip' ? 'active' : ''}`} onClick={() => verdict('skip')}>
          ⏭ Skip
        </button>
      </div>

      <div class="note-tools row" style={{ justifyContent: 'space-between' }}>
        <button class="linkish" onClick={() => setDialogOpen(true)}>
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
        open={dialogOpen}
        title={status === 'fail' ? 'Note the failure' : 'Step note'}
        hint={status === 'fail' ? 'A note is encouraged so the failure is actionable.' : undefined}
        initial={note ?? ''}
        onSave={(n) => {
          props.onNote(n);
          closeDialog();
        }}
        onClose={closeDialog}
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
