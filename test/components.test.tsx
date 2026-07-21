import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/preact';
import { StepCard } from '../src/components/StepCard';
import { PhaseNav } from '../src/components/PhaseNav';
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
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
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
});

describe('PhaseNav', () => {
  it('reflects step status in the expanded step list', () => {
    let state = emptyState();
    state = setStep(state, flat[0].step.id, { status: 'pass' });
    state = setStep(state, flat[1].step.id, { status: 'fail' });
    const { getByText, container } = render(
      <PhaseNav doc={doc} state={state} currentIndex={0} onJump={vi.fn()} />,
    );
    // expand the first phase
    fireEvent.click(getByText('1. Brewing'));
    const dots = container.querySelectorAll('.phase-steps .dot');
    expect(dots[0].classList.contains('pass')).toBe(true);
    expect(dots[1].classList.contains('fail')).toBe(true);
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
