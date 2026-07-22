import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/preact';
import { StepCard } from '../src/components/StepCard';
import { PhaseNav } from '../src/components/PhaseNav';
import { FailNoteDialog } from '../src/components/FailNoteDialog';
import { buildRunDoc, flattenSteps } from '../src/lib/parse';
import { emptyState, setStep } from '../src/lib/state';
import type { LinkContext } from '../src/lib/links';
import { source, dirFiles } from './fixtures';

const doc = buildRunDoc(source, dirFiles);
const flat = flattenSteps(doc);

const linkCtx: LinkContext = {
  appHost: 'machine.local',
  owner: 'acme',
  repo: 'coffee-qa',
  sha: 'deadbeef',
  filePath: flat[0].group.filePath,
};

function renderStep(overrides: Partial<Parameters<typeof StepCard>[0]> = {}) {
  const onVerdict = vi.fn();
  const onNote = vi.fn();
  const onFailResolved = vi.fn();
  const utils = render(
    <StepCard
      phase={flat[0].phase}
      step={flat[0].step}
      positionText="Phase 1 · Step 1/3"
      status="pending"
      linkCtx={linkCtx}
      hasBack={false}
      hasNext={true}
      onVerdict={onVerdict}
      onNote={onNote}
      onFailResolved={onFailResolved}
      onBack={vi.fn()}
      onNext={vi.fn()}
      {...overrides}
    />,
  );
  return { ...utils, onVerdict, onNote, onFailResolved };
}

describe('StepCard', () => {
  it('renders position and the rendered body markdown', () => {
    const { getByText, container } = renderStep();
    expect(getByText('Phase 1 · Step 1/3')).toBeTruthy();
    // body markdown rendered to HTML (bold label present)
    expect(container.querySelector('.body strong')?.textContent).toContain('Power on');
  });

  it('routes app-host links to the reusable app tab', () => {
    const { container } = renderStep();
    const link = container.querySelector('.body a[href="https://machine.local/panel"]') as HTMLAnchorElement;
    expect(link.getAttribute('target')).toBe('qa-app');
    expect(link.getAttribute('referrerpolicy')).toBe('no-referrer');
  });

  it('fires onVerdict with the chosen status', () => {
    const { getByText, onVerdict } = renderStep();
    fireEvent.click(getByText('✓ Pass'));
    expect(onVerdict).toHaveBeenCalledWith('pass');
    fireEvent.click(getByText('⏭ Skip'));
    expect(onVerdict).toHaveBeenCalledWith('skip');
  });

  it('opens the note dialog automatically on Fail', () => {
    const { getByText, onVerdict, container } = renderStep();
    fireEvent.click(getByText('✕ Fail'));
    expect(onVerdict).toHaveBeenCalledWith('fail');
    // a modal textarea is now present
    expect(container.querySelector('dialog textarea')).toBeTruthy();
  });

  it('lets you add a note on a non-fail status and reports it', () => {
    const { getByText, container, onNote } = renderStep({ status: 'pass' });
    fireEvent.click(getByText('＋ Add note'));
    const ta = container.querySelector('dialog textarea') as HTMLTextAreaElement;
    fireEvent.input(ta, { target: { value: 'looked good' } });
    fireEvent.submit(ta.closest('form')!);
    expect(onNote).toHaveBeenCalledWith('looked good');
  });

  it('shows the screenshot bridge only when an issue is active', () => {
    const withIssue = renderStep({ issueUrl: 'https://github.com/acme/coffee-qa/issues/5' });
    expect(withIssue.queryByText(/Attach screenshot via issue/)).toBeTruthy();
    withIssue.unmount();
    const noIssue = renderStep();
    expect(noIssue.queryByText(/Attach screenshot via issue/)).toBeNull();
  });

  it('opens the note dialog when the keyboard "f" fires (H3)', () => {
    const { container, onVerdict } = renderStep();
    fireEvent.keyDown(window, { key: 'f' });
    expect(onVerdict).toHaveBeenCalledWith('fail');
    expect(container.querySelector('dialog textarea')).toBeTruthy();
  });

  it('routes keyboard "p"/"s" through the verdict path', () => {
    const pass = renderStep();
    fireEvent.keyDown(window, { key: 'p' });
    expect(pass.onVerdict).toHaveBeenCalledWith('pass');
    pass.unmount();
    const skip = renderStep();
    fireEvent.keyDown(window, { key: 's' });
    expect(skip.onVerdict).toHaveBeenCalledWith('skip');
  });

  it('suppresses shortcuts while the dialog is open (L3)', () => {
    const { onVerdict } = renderStep();
    fireEvent.keyDown(window, { key: 'f' }); // opens dialog, 1 fail
    expect(onVerdict).toHaveBeenCalledTimes(1);
    // Any further shortcut while the dialog is open is ignored — including focus
    // on a dialog button, since suppression keys off dialog-open state, not the
    // focused tag. (A plain BUTTON would otherwise slip past resolveKeyAction.)
    fireEvent.keyDown(window, { key: 'f' });
    fireEvent.keyDown(window, { key: 'p' });
    expect(onVerdict).toHaveBeenCalledTimes(1);
  });

  it('guards a rapid double verdict keypress within one card (L8)', () => {
    const { onVerdict } = renderStep();
    fireEvent.keyDown(window, { key: 'p' });
    fireEvent.keyDown(window, { key: 'p' });
    // Second press is swallowed by the per-instance guard.
    expect(onVerdict).toHaveBeenCalledTimes(1);
  });

  it('renders phase and group intros when provided (M5)', () => {
    const { container, getByText } = renderStep({
      phaseIntro: 'Warm up the machine before this phase.',
      groupIntro: 'These steps all touch the **grinder**.',
    });
    expect(getByText('Phase notes')).toBeTruthy();
    expect(getByText('Section notes')).toBeTruthy();
    const details = Array.from(container.querySelectorAll('details.intro'));
    expect(details).toHaveLength(2);
    // intro markdown is rendered (bold span present)
    expect(container.querySelector('details.intro strong')?.textContent).toContain('grinder');
  });

  it('omits intro sections when not provided (negative)', () => {
    const { container } = renderStep();
    expect(container.querySelector('details.intro')).toBeNull();
  });

  it('cancelling the dialog after a keyboard fail keeps the fail and advances', () => {
    const { container, onVerdict, onFailResolved } = renderStep();
    fireEvent.keyDown(window, { key: 'f' });
    expect(onVerdict).toHaveBeenCalledWith('fail');
    const cancelBtn = Array.from(container.querySelectorAll('dialog button')).find(
      (b) => b.textContent === 'Cancel',
    ) as HTMLButtonElement;
    fireEvent.click(cancelBtn);
    // Fail verdict already applied; closing advances past the step.
    expect(onFailResolved).toHaveBeenCalledTimes(1);
  });
});

describe('FailNoteDialog', () => {
  it('saves the trimmed text on submit', () => {
    const onSave = vi.fn();
    const onClose = vi.fn();
    const { container } = render(
      <FailNoteDialog open title="Note" initial="" onSave={onSave} onClose={onClose} />,
    );
    const ta = container.querySelector('dialog textarea') as HTMLTextAreaElement;
    fireEvent.input(ta, { target: { value: '  boom  ' } });
    fireEvent.submit(ta.closest('form')!);
    expect(onSave).toHaveBeenCalledWith('boom');
  });

  it('Cancel discards edits: onClose fires and onSave does not', () => {
    const onSave = vi.fn();
    const onClose = vi.fn();
    const { getByText, container } = render(
      <FailNoteDialog open title="Note" initial="original" onSave={onSave} onClose={onClose} />,
    );
    const ta = container.querySelector('dialog textarea') as HTMLTextAreaElement;
    fireEvent.input(ta, { target: { value: 'typed but discarded' } });
    fireEvent.click(getByText('Cancel'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('Esc (dialog cancel event) discards and closes without saving', () => {
    const onSave = vi.fn();
    const onClose = vi.fn();
    const { container } = render(
      <FailNoteDialog open title="Note" initial="" onSave={onSave} onClose={onClose} />,
    );
    const dialog = container.querySelector('dialog') as HTMLDialogElement;
    fireEvent(dialog, new Event('cancel'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });
});

describe('PhaseNav', () => {
  it('reflects step status in the expanded step list', () => {
    let state = emptyState();
    state = setStep(state, flat[0].step.id, { status: 'pass' });
    state = setStep(state, flat[1].step.id, { status: 'fail' });
    const { container } = render(
      <PhaseNav doc={doc} state={state} currentIndex={0} onJump={vi.fn()} />,
    );
    // The phase holding currentIndex starts expanded, so no click is needed.
    const dots = container.querySelectorAll('.phase-steps .dot');
    expect(dots[0].classList.contains('pass')).toBe(true);
    expect(dots[1].classList.contains('fail')).toBe(true);
  });

  it('opens on the phase holding currentIndex, not the first phase', () => {
    // currentIndex sits in phase 2; phase 1's steps must NOT be listed.
    const inPhase2 = flat.findIndex((n) => n.phase.id !== flat[0].phase.id);
    expect(inPhase2).toBeGreaterThan(0);
    const { container, getByText } = render(
      <PhaseNav doc={doc} state={emptyState()} currentIndex={inPhase2} onJump={vi.fn()} />,
    );
    const labels = Array.from(container.querySelectorAll('.phase-steps .lbl')).map(
      (el) => el.textContent,
    );
    expect(labels).toContain(flat[inPhase2].step.label);
    expect(labels).not.toContain(flat[0].step.label);

    // Clicking the already-open phase collapses it.
    fireEvent.click(getByText('2. Cleaning'));
    expect(container.querySelectorAll('.phase-steps .lbl').length).toBe(0);
  });

  it('calls onJump with the global index when a step is clicked', () => {
    const onJump = vi.fn();
    const { getByText } = render(<PhaseNav doc={doc} state={emptyState()} currentIndex={0} onJump={onJump} />);
    fireEvent.click(getByText('2. Cleaning'));
    fireEvent.click(getByText('Wipe the steam wand.'));
    // Brewing has 3 steps; Cleaning steps start at global index 3; "Wipe" is the 3rd cleaning step.
    expect(onJump).toHaveBeenCalledWith(5);
  });
});
