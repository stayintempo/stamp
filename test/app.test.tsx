import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, waitFor, cleanup, act } from '@testing-library/preact';
import { App, parseIssueNumber } from '../src/app';
import { GithubClient, type IssueRef } from '../src/lib/github';
import { formatMarker, type RunMeta } from '../src/lib/state';

// A tiny two-step checklist the fake client serves.
const MD = '# QA\n\n- [ ] **Step one.** press it\n- [ ] **Step two.** press it too';
const CANONICAL = 'o/r/QA';
const SHA = 'sha123';

const META = (over: Partial<RunMeta> = {}): RunMeta => ({
  docUrl: CANONICAL,
  sha: SHA,
  path: 'QA',
  tool: 'stamp@0.0.0',
  ...over,
});

/** A valid STAMP issue body: marker for this doc + the two task lines. */
function stampBody(over: Partial<RunMeta> = {}, lines = '- [ ] Step one.\n- [ ] Step two.'): string {
  return `${formatMarker(META(over))}\n\n${lines}`;
}

interface FakeOpts {
  getIssue?: (num: number) => IssueRef;
  updateIssueBody?: (num: number, body: string) => Promise<IssueRef>;
  createIssue?: (title: string, body: string) => IssueRef;
  addComment?: () => Promise<void>;
  listStampIssues?: () => Promise<IssueRef[]>;
  failResolve?: boolean;
}

/** A GithubClient stand-in exposing just the methods App exercises. */
function fakeClient(o: FakeOpts = {}) {
  const calls = {
    createIssue: vi.fn(async (_o: string, _r: string, title: string, body: string) =>
      o.createIssue
        ? o.createIssue(title, body)
        : { number: 5, htmlUrl: 'https://github.com/o/r/issues/5', title, body },
    ),
    getIssue: vi.fn(async (_o: string, _r: string, num: number) =>
      o.getIssue
        ? o.getIssue(num)
        : { number: num, htmlUrl: `https://github.com/o/r/issues/${num}`, title: 't', body: stampBody() },
    ),
    updateIssueBody: vi.fn(async (_o: string, _r: string, num: number, body: string) =>
      o.updateIssueBody
        ? o.updateIssueBody(num, body)
        : { number: num, htmlUrl: 'u', title: 't', body },
    ),
    addComment: vi.fn(async () => (o.addComment ? o.addComment() : undefined)),
    listStampIssues: vi.fn(async () => (o.listStampIssues ? o.listStampIssues() : [])),
    patchIssueBodyKeepalive: vi.fn(),
    // loadRunDoc dependencies
    getDefaultBranch: vi.fn(async () => (o.failResolve ? Promise.reject(new Error('boom')) : 'main')),
    resolveCommitSha: vi.fn(async () => SHA),
    listTree: vi.fn(async () => [{ path: 'QA/README.md', type: 'blob' }]),
    getRawFile: vi.fn(async () => MD),
  };
  const client = calls as unknown as GithubClient;
  return { client, calls };
}

function renderApp(opts: FakeOpts = {}) {
  const { client, calls } = fakeClient(opts);
  const utils = render(<App createClient={() => client} />);
  return { ...utils, calls };
}

/** Fill the setup form and connect; resolve at the Start panel. */
async function connect(utils: ReturnType<typeof renderApp>, url = 'o/r/QA') {
  const input = utils.container.querySelector('#gh') as HTMLInputElement;
  fireEvent.input(input, { target: { value: url } });
  fireEvent.submit(input.closest('form')!);
  await waitFor(() => expect(utils.getByText(/Start a new run/)).toBeTruthy());
}

/**
 * Preact defers useEffect past the waitFor that a DOM assertion resolves on, so
 * the run screen's keyboard listener is not attached yet when the step card
 * first appears. Pump real time so the scheduled flush lands before a test
 * presses a key.
 */
const flushEffects = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

/** Connect and start a brand-new issue-backed run; resolve at the run view. */
async function startRun(utils: ReturnType<typeof renderApp>) {
  await connect(utils);
  fireEvent.click(utils.getByText(/Start a new run/));
  await waitFor(() => expect(utils.container.querySelector('.stepcard')).toBeTruthy());
  await flushEffects();
}

beforeEach(() => localStorage.clear());
afterEach(() => cleanup());

describe('parseIssueNumber', () => {
  it('parses #-prefixed, bare, and issue-URL forms', () => {
    expect(parseIssueNumber('#42')).toBe(42);
    expect(parseIssueNumber('42')).toBe(42);
    expect(parseIssueNumber('https://github.com/o/r/issues/7')).toBe(7);
  });
  it('rejects non-numbers (negative)', () => {
    expect(parseIssueNumber('nope')).toBeUndefined();
    expect(parseIssueNumber('')).toBeUndefined();
  });
});

describe('connect', () => {
  it('loads the checklist and shows the Start panel (happy path)', async () => {
    const utils = renderApp();
    await connect(utils);
    expect(utils.getByText(/Loaded 1 phase/)).toBeTruthy();
  });

  it('surfaces an error and stays on setup when loading fails', async () => {
    const utils = renderApp({ failResolve: true });
    const input = utils.container.querySelector('#gh') as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'o/r/QA' } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(utils.getByText('boom')).toBeTruthy());
    // still on setup (connect button present), not the start panel
    expect(utils.queryByText(/Start a new run/)).toBeNull();
  });
});

describe('startNewIssue', () => {
  it('creates an issue with a dated QA-run title and enters the run', async () => {
    const utils = renderApp();
    await startRun(utils);
    expect(utils.calls.createIssue).toHaveBeenCalledTimes(1);
    const title = utils.calls.createIssue.mock.calls[0][2] as string;
    expect(title).toMatch(/^QA run: QA @ main \(\d{4}-\d{2}-\d{2}\)$/);
  });
});

describe('resumeIssue validation (H2)', () => {
  async function tryResume(utils: ReturnType<typeof renderApp>, num = '9') {
    await connect(utils);
    const resumeInput = utils.getByPlaceholderText('issue # or issue URL') as HTMLInputElement;
    fireEvent.input(resumeInput, { target: { value: num } });
    fireEvent.click(utils.getByText('Resume'));
  }

  it('refuses an issue with no STAMP marker', async () => {
    const utils = renderApp({ getIssue: (n) => ({ number: n, htmlUrl: 'u', title: 't', body: 'just prose' }) });
    await tryResume(utils);
    await waitFor(() => expect(utils.getByText(/not a STAMP run/)).toBeTruthy());
    expect(utils.container.querySelector('.stepcard')).toBeNull();
  });

  it('refuses an issue whose marker points at a different checklist', async () => {
    const utils = renderApp({
      getIssue: (n) => ({ number: n, htmlUrl: 'u', title: 't', body: stampBody({ docUrl: 'other/repo/QB' }) }),
    });
    await tryResume(utils);
    await waitFor(() => expect(utils.getByText(/different checklist/)).toBeTruthy());
    expect(utils.container.querySelector('.stepcard')).toBeNull();
  });

  it('requires confirmation when the marker SHA differs, then resumes', async () => {
    const utils = renderApp({
      getIssue: (n) => ({ number: n, htmlUrl: 'u', title: 't', body: stampBody({ sha: 'DIFFERENT' }) }),
    });
    await tryResume(utils);
    // confirmation prompt, not yet in the run
    await waitFor(() => expect(utils.getByText(/different revision/)).toBeTruthy());
    expect(utils.container.querySelector('.stepcard')).toBeNull();
    fireEvent.click(utils.getByText('Resume anyway'));
    await waitFor(() => expect(utils.container.querySelector('.stepcard')).toBeTruthy());
  });

  it('adopts local state over the issue body when a local run exists (H4b)', async () => {
    // Pre-seed a local run where step one is already passed.
    const utils = renderApp({ getIssue: (n) => ({ number: n, htmlUrl: 'u', title: 't', body: stampBody() }) });
    await connect(utils);
    // Build the local key the same way App does: canonical#sha#issue.
    // Step ids are derived from the parsed doc; seed via the same doc build.
    const { buildRunDoc, flattenSteps } = await import('../src/lib/parse');
    const { emptyState, setStep } = await import('../src/lib/state');
    const doc = buildRunDoc({ owner: 'o', repo: 'r', ref: 'main', sha: SHA, path: 'QA' }, [
      { path: 'QA/README.md', content: MD },
    ]);
    const flat = flattenSteps(doc);
    const local = setStep(emptyState(), flat[0].step.id, { status: 'pass' });
    localStorage.setItem(`stamp:run:${CANONICAL}#${SHA}#9`, JSON.stringify(local));

    const resumeInput = utils.getByPlaceholderText('issue # or issue URL') as HTMLInputElement;
    fireEvent.input(resumeInput, { target: { value: '9' } });
    fireEvent.click(utils.getByText('Resume'));
    await waitFor(() => expect(utils.container.querySelector('.stepcard')).toBeTruthy());
    // firstPending skips the locally-passed step 1 → lands on Step 2/2.
    expect(utils.getByText(/Step 2\/2/)).toBeTruthy();
  });
});

describe('run screen layout (phase list is on demand)', () => {
  it('shows no phase list above the step card until the header control is used', async () => {
    const utils = renderApp();
    await startRun(utils);
    // The step card is what the tester acts on: nothing but the header precedes it.
    expect(utils.container.querySelector('.phasenav')).toBeNull();
    const pick = utils.container.querySelector('.phase-pick') as HTMLButtonElement;
    expect(pick).toBeTruthy();
    expect(pick.getAttribute('aria-expanded')).toBe('false');
    expect(pick.textContent).toContain('Phase 1/1');
  });

  it('opens the phase drawer from the header and closes it on jump', async () => {
    const utils = renderApp();
    await startRun(utils);
    fireEvent.click(utils.container.querySelector('.phase-pick') as HTMLButtonElement);
    expect(utils.container.querySelector('.phasenav')).toBeTruthy();
    expect(
      (utils.container.querySelector('.phase-pick') as HTMLButtonElement).getAttribute(
        'aria-expanded',
      ),
    ).toBe('true');

    // Jumping to a step dismisses the drawer and moves the run there.
    const steps = utils.container.querySelectorAll('.phase-steps button');
    fireEvent.click(steps[1]);
    await waitFor(() => expect(utils.container.querySelector('.phasenav')).toBeNull());
    expect(utils.container.querySelector('.stepcard .pos')?.textContent).toContain('Step 2/2');
  });

  it('Escape closes the drawer without changing the step', async () => {
    const utils = renderApp();
    await startRun(utils);
    fireEvent.click(utils.container.querySelector('.phase-pick') as HTMLButtonElement);
    expect(utils.container.querySelector('.phasenav')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(utils.container.querySelector('.phasenav')).toBeNull());
    expect(utils.container.querySelector('.stepcard .pos')?.textContent).toContain('Step 1/2');
  });

});

describe('run keyboard shortcuts', () => {
  const pos = (u: ReturnType<typeof renderApp>) =>
    u.container.querySelector('.stepcard .pos')?.textContent ?? '';
  const status = (u: ReturnType<typeof renderApp>) =>
    u.container.querySelector('.stepcard .statusline')?.textContent ?? '';

  it('marks pass and advances', async () => {
    const utils = renderApp();
    await startRun(utils);
    fireEvent.keyDown(window, { key: 'p' });
    await waitFor(() => expect(pos(utils)).toContain('Step 2/2'));
  });

  it('marks fail and opens the note editor instead of advancing', async () => {
    const utils = renderApp();
    await startRun(utils);
    fireEvent.keyDown(window, { key: 'f' });
    await waitFor(() => expect(utils.container.querySelector('dialog textarea')).toBeTruthy());
    expect(pos(utils)).toContain('Step 1/2');
    expect(status(utils)).toContain('Failed');
  });

  it('arrow keys move without marking', async () => {
    const utils = renderApp();
    await startRun(utils);
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    await waitFor(() => expect(pos(utils)).toContain('Step 2/2'));
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    await waitFor(() => expect(pos(utils)).toContain('Step 1/2'));
    expect(status(utils)).toContain('Pending');
  });

  it('guards a second verdict keypress in the same frame (L8)', async () => {
    const utils = renderApp();
    await startRun(utils);
    // Raw dispatch, NOT fireEvent: fireEvent wraps each call in act and flushes
    // effects, which would rebind the listener to the next step in between and
    // make the two presses legitimately land on different steps. Dispatching
    // directly is the real scenario — two keypresses before a single re-render.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f' }));
    await flushEffects();
    await waitFor(() => expect(pos(utils)).toContain('Step 2/2'));
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    await waitFor(() => expect(pos(utils)).toContain('Step 1/2'));
    // The 'f' was swallowed: step one is still passed, not failed.
    expect(status(utils)).toContain('Passed');
  });

  it('re-arms the guard when you step back to a step', async () => {
    const utils = renderApp();
    await startRun(utils);
    fireEvent.keyDown(window, { key: 'p' });
    await waitFor(() => expect(pos(utils)).toContain('Step 2/2'));
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    await waitFor(() => expect(pos(utils)).toContain('Step 1/2'));
    expect(status(utils)).toContain('Passed');
    // Arriving at a step clears the guard, so the verdict can be changed. The
    // new verdict advances, so read it back after stepping in again.
    fireEvent.keyDown(window, { key: 's' });
    await waitFor(() => expect(pos(utils)).toContain('Step 2/2'));
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    await waitFor(() => expect(pos(utils)).toContain('Step 1/2'));
    expect(status(utils)).toContain('Skipped');
  });

  // One modalOpen flag gates one listener, so every overlay is covered by
  // construction. The settings case was broken before that consolidation.
  const overlays: Array<[string, (u: ReturnType<typeof renderApp>) => void]> = [
    ['the phase drawer', (u) => fireEvent.click(u.container.querySelector('.phase-pick')!)],
    ['the settings overlay', (u) => fireEvent.click(u.getByText('⚙︎'))],
    ['the note editor', () => fireEvent.keyDown(window, { key: 'f' })],
  ];

  for (const [name, open] of overlays) {
    it(`does NOT let a verdict shortcut fire through ${name}`, async () => {
      const utils = renderApp();
      await startRun(utils);
      if (name === 'the note editor') {
        // Fail first, then confirm further shortcuts cannot change that verdict.
        open(utils);
        await waitFor(() => expect(status(utils)).toContain('Failed'));
        fireEvent.keyDown(window, { key: 'p' });
        expect(pos(utils)).toContain('Step 1/2');
        expect(status(utils)).toContain('Failed');
        return;
      }
      open(utils);
      fireEvent.keyDown(window, { key: 'p' });
      expect(pos(utils)).toContain('Step 1/2');
      expect(status(utils)).toContain('Pending');
    });
  }
});

describe('flushPatch (debounced sync)', () => {
  it('coalesces rapid changes into one PATCH carrying the latest state', async () => {
    const utils = renderApp();
    await startRun(utils);
    vi.useFakeTimers();
    try {
      fireEvent.click(utils.getByText('✓ Pass')); // step one pass -> advances
      fireEvent.click(utils.getByText('✕ Fail')); // step two fail (opens dialog)
      await vi.advanceTimersByTimeAsync(3000);
      expect(utils.calls.updateIssueBody).toHaveBeenCalledTimes(1);
      const body = utils.calls.updateIssueBody.mock.calls[0][3] as string;
      expect(body).toMatch(/- \[x\] Step one\./);
    } finally {
      vi.useRealTimers();
    }
  });

  it('marks sync errored on a failed PATCH and retries on demand', async () => {
    let attempt = 0;
    const utils = renderApp({
      updateIssueBody: async (num, body) => {
        attempt++;
        if (attempt === 1) throw new Error('network down');
        return { number: num, htmlUrl: 'u', title: 't', body };
      },
    });
    await startRun(utils);
    vi.useFakeTimers();
    try {
      fireEvent.click(utils.getByText('✓ Pass'));
      await vi.advanceTimersByTimeAsync(3000);
      await waitFor(() => expect(utils.getByText(/sync failed/)).toBeTruthy());
      // manual retry succeeds
      fireEvent.click(utils.getByText('Retry'));
      await vi.advanceTimersByTimeAsync(0);
      await waitFor(() => expect(utils.getByText(/synced/)).toBeTruthy());
      expect(utils.calls.updateIssueBody).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('pagehide flush (H4c)', () => {
  it('fires a keepalive PATCH when the tab is hidden mid-debounce', async () => {
    const utils = renderApp();
    await startRun(utils);
    fireEvent.click(utils.getByText('✓ Pass')); // dirty, debounce pending
    window.dispatchEvent(new Event('pagehide'));
    expect(utils.calls.patchIssueBodyKeepalive).toHaveBeenCalledTimes(1);
  });
});

describe('summary posting (M6)', () => {
  it('posts a summary comment exactly once and disables the button after', async () => {
    const utils = renderApp();
    await startRun(utils);
    fireEvent.click(utils.getByText(/Finish ▸/));
    await waitFor(() => expect(utils.getByText(/Post summary comment/)).toBeTruthy());
    const btn = utils.getByText(/Post summary comment/) as HTMLButtonElement;
    fireEvent.click(btn);
    await waitFor(() => expect(utils.getByText(/Summary posted/)).toBeTruthy());
    // clicking the (now disabled/posted) button again does not re-post
    fireEvent.click(utils.getByText(/Summary posted/));
    expect(utils.calls.addComment).toHaveBeenCalledTimes(1);
  });

  it('shows an error when posting fails', async () => {
    const utils = renderApp({
      addComment: async () => {
        throw new Error('comment rejected');
      },
    });
    await startRun(utils);
    fireEvent.click(utils.getByText(/Finish ▸/));
    fireEvent.click(await utils.findByText(/Post summary comment/));
    await waitFor(() => expect(utils.getByText(/comment rejected/)).toBeTruthy());
  });
});
