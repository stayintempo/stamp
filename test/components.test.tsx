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
  const onOpenNote = vi.fn();
  const onCloseNote = vi.fn();
  const utils = render(
    <StepCard
      phase={flat[0].phase}
      step={flat[0].step}
      positionText="Phase 1 · Step 1/3"
      status="pending"
      linkCtx={linkCtx}
      hasBack={false}
      hasNext={true}
      noteOpen={false}
      onOpenNote={onOpenNote}
      onCloseNote={onCloseNote}
      onVerdict={onVerdict}
      onNote={onNote}
      onBack={vi.fn()}
      onNext={vi.fn()}
      {...overrides}
    />,
  );
  return { ...utils, onVerdict, onNote, onOpenNote, onCloseNote };
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

  it('asks App to open the note editor rather than owning it', () => {
    const { getByText, onOpenNote, container } = renderStep();
    fireEvent.click(getByText('＋ Add note'));
    expect(onOpenNote).toHaveBeenCalledTimes(1);
    // StepCard holds no dialog state of its own: nothing opened locally.
    expect(container.querySelector('dialog textarea')).toBeNull();
  });

  it('renders and submits the note editor when App says it is open', () => {
    const { container, onNote, onCloseNote } = renderStep({ noteOpen: true, status: 'pass' });
    const ta = container.querySelector('dialog textarea') as HTMLTextAreaElement;
    fireEvent.input(ta, { target: { value: 'looked good' } });
    fireEvent.submit(ta.closest('form')!);
    expect(onNote).toHaveBeenCalledWith('looked good');
    expect(onCloseNote).toHaveBeenCalledTimes(1);
  });

  it('shows the screenshot bridge only when an issue is active', () => {
    const withIssue = renderStep({ issueUrl: 'https://github.com/acme/coffee-qa/issues/5' });
    expect(withIssue.queryByText(/Attach screenshot via issue/)).toBeTruthy();
    withIssue.unmount();
    const noIssue = renderStep();
    expect(noIssue.queryByText(/Attach screenshot via issue/)).toBeNull();
  });

  it('installs no keyboard listener of its own', () => {
    const { onVerdict } = renderStep();
    fireEvent.keyDown(window, { key: 'p' });
    fireEvent.keyDown(window, { key: 'f' });
    // Shortcuts are App's job now — see the keyboard tests in app.test.tsx.
    expect(onVerdict).not.toHaveBeenCalled();
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
