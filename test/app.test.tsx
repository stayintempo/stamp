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
  /** Override the tree walk (default: a single QA/README.md). */
  tree?: Array<{ path: string; type: string }>;
  /** Override raw file content per path (default: the two-step MD). */
  rawFor?: (path: string) => string;
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
    listTree: vi.fn(async () => o.tree ?? [{ path: 'QA/README.md', type: 'blob' }]),
    getRawFile: vi.fn(async (_o: string, _r: string, path: string) => (o.rawFor ? o.rawFor(path) : MD)),
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
 * first appears. Wait out Preact's own flush chain rather than a fixed delay:
 * `afterNextFrame` registers a rAF callback (plus a 35ms timer as a fallback)
 * and that callback schedules the flush on one more timer. A pending flush
 * therefore registered its rAF before ours and, since jsdom runs same-frame
 * callbacks in registration order and timers queued in the same tick fire
 * FIFO, its flush always lands before we resolve. A fixed pump instead races
 * the frame and loses on a busy machine, which made every keyboard test
 * flaky (#18).
 *
 * The act() wrapper is load-bearing, not decoration: it captures any flush
 * scheduled during the wait and drains it on exit, which is what covers an
 * effect that sets state and so queues a further deferred effect. Do not
 * reduce this to a bare promise.
 */
const flushEffects = () =>
  act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
  });

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

  it('shows the ref and the pinned sha so the tester can see what they got', async () => {
    const utils = renderApp();
    await connect(utils);
    expect(utils.getByText(/Loaded 1 phase/).textContent).toMatch(/pinned to\s*main\s*@\s*sha123/);
  });

  it('carries a typed @ref through to the Start panel and skips the default branch', async () => {
    const utils = renderApp();
    await connect(utils, 'o/r/QA@v1.2.0');
    expect(utils.getByText(/Loaded 1 phase/).textContent).toMatch(/pinned to\s*v1\.2\.0\s*@\s*sha123/);
    expect(utils.calls.resolveCommitSha).toHaveBeenCalledWith('o', 'r', 'v1.2.0');
    // negative: pinning means the default branch is never consulted
    expect(utils.calls.getDefaultBranch).not.toHaveBeenCalled();
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

  it('a mid-session PATCH preserves an external seed-qa check the live issue gained (fix 5)', async () => {
    // The live issue, as seed-qa leaves it between the tester's edits: step two
    // checked with a provenance note that local state has never seen.
    const seeded = stampBody({}, '- [ ] Step one.\n- [x] Step two.\n  - 📝 seeded by seed-qa @abc');
    const utils = renderApp({
      getIssue: (n) => ({ number: n, htmlUrl: 'u', title: 't', body: seeded }),
    });
    await startRun(utils);
    vi.useFakeTimers();
    try {
      fireEvent.click(utils.getByText('✓ Pass')); // tester passes step one -> schedules a PATCH
      await vi.advanceTimersByTimeAsync(3000);
      expect(utils.calls.updateIssueBody).toHaveBeenCalledTimes(1);
      const body = utils.calls.updateIssueBody.mock.calls[0][3] as string;
      // The tester's pass lands AND the external seed-qa check survives, note intact
      // (without the reconcile the rewrite from local state would erase step two).
      expect(body).toMatch(/- \[x\] Step one\./);
      expect(body).toMatch(/- \[x\] Step two\./);
      expect(body).toContain('📝 seeded by seed-qa @abc');
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

describe('reduced mode (phase 2)', () => {
  const README =
    '# QA\n\n- [ ] **Alpha.** a <!-- qa:01.a -->\n- [ ] **Beta.** b <!-- qa:02.b -->\n- [ ] **Gamma.** c <!-- qa:03.c -->';
  const LEDGER = [
    '## Per-box ledger',
    '',
    '| Sec | # | Box | Tag | Owner | ID |',
    '| - | - | - | - | - | - |',
    '| 01 | 1 | Alpha | CI | dev | qa:01.a |',
    '| 01 | 2 | Beta | CHECK | qa | qa:02.b |',
    '| 01 | 3 | Gamma | SEED | dev | qa:03.c |',
  ].join('\n');
  const withCoverage: FakeOpts = {
    tree: [
      { path: 'QA/README.md', type: 'blob' },
      { path: 'QA/COVERAGE.md', type: 'blob' },
    ],
    rawFor: (p) => (p.includes('COVERAGE') ? LEDGER : README),
  };

  it('auto-skips CI/SEED boxes and banners the count when enabled', async () => {
    const utils = renderApp(withCoverage);
    const input = utils.container.querySelector('#gh') as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'o/r/QA' } });
    const checkbox = utils.container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    fireEvent.click(checkbox);
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(utils.getByText(/Start a new run/)).toBeTruthy());
    fireEvent.click(utils.getByText(/Start a new run/));
    await waitFor(() => expect(utils.container.querySelector('.stepcard')).toBeTruthy());
    await flushEffects();
    // qa:01.a (CI) + qa:03.c (SEED) auto-skipped = 2; qa:02.b (CHECK) untouched.
    expect(utils.container.textContent).toMatch(/2 steps auto-skipped \(machine-covered\)/);
    // The run lands on the first pending (non-covered) box, Beta.
    expect(utils.container.querySelector('.stepcard')?.textContent).toContain('Beta');
  });

  /** Connect with reduced mode ON and start a fresh issue-backed run. */
  async function startReducedRun(utils: ReturnType<typeof renderApp>) {
    const input = utils.container.querySelector('#gh') as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'o/r/QA' } });
    fireEvent.click(utils.container.querySelector('input[type="checkbox"]') as HTMLInputElement);
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(utils.getByText(/Start a new run/)).toBeTruthy());
    fireEvent.click(utils.getByText(/Start a new run/));
    await waitFor(() => expect(utils.container.querySelector('.stepcard')).toBeTruthy());
    await flushEffects();
  }

  it('serializes the auto-skips into the created issue body, no follow-up PATCH (fix 8)', async () => {
    const utils = renderApp(withCoverage);
    await startReducedRun(utils);
    const createdBody = utils.calls.createIssue.mock.calls[0][3] as string;
    // The created body already carries the auto-skips (CI + SEED), so there is no
    // window where an all-pending body races the external seed-qa writer.
    expect(createdBody).toMatch(/- \[ \] Alpha\. <!-- qa:01\.a -->/);
    expect(createdBody).toContain('auto: machine-covered (CI)');
    expect(createdBody).toContain('auto: machine-covered (SEED)');
    // Beta (CHECK) is left pending, un-skipped; only the two covered boxes skip.
    expect(createdBody).toMatch(/- \[ \] Beta\. <!-- qa:02\.b -->/);
    expect(createdBody.match(/⏭ skipped/g)?.length).toBe(2);
    // No follow-up PATCH is needed to add the skips.
    expect(utils.calls.updateIssueBody).not.toHaveBeenCalled();
  });

  it('a tester pass over an auto-skip is not downgraded by the reconcile flush (fix 6)', async () => {
    const utils = renderApp(withCoverage);
    await startReducedRun(utils);
    // Lands on Beta (first pending). Step back to the auto-skipped Alpha (CI).
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    await waitFor(() =>
      expect(utils.container.querySelector('.stepcard')?.textContent).toContain('Alpha'),
    );
    fireEvent.keyDown(window, { key: 'p' }); // tester passes the auto-skipped box
    // Force the teardown keepalive flush; its reconcile must keep Alpha's pass,
    // not downgrade it to the issue-side auto-skip, and the inherited auto note
    // must be gone (dropped when the verdict was applied).
    window.dispatchEvent(new Event('pagehide'));
    expect(utils.calls.patchIssueBodyKeepalive).toHaveBeenCalledTimes(1);
    const body = utils.calls.patchIssueBodyKeepalive.mock.calls[0][3] as string;
    expect(body).toMatch(/- \[x\] Alpha\./); // pass survives the reconcile
    expect(body).not.toContain('machine-covered (CI)'); // Alpha's auto note dropped
    expect(body).toContain('machine-covered (SEED)'); // Gamma still auto-skipped
  });

  it('does nothing with the toggle off, even when a ledger is present (negative)', async () => {
    const utils = renderApp(withCoverage);
    await startRun(utils); // connect() leaves the reduced box unchecked
    expect(utils.queryByText(/auto-skipped/)).toBeNull();
    // Every box is still pending: the run starts on Alpha.
    expect(utils.container.querySelector('.stepcard')?.textContent).toContain('Alpha');
  });

  it('resuming an existing run with reduced mode on pre-seeds nothing (fix 7 negative)', async () => {
    // A shared full-mode run: all boxes pending, no auto-skips in the body.
    const resumeBody = `${formatMarker(META())}\n\n## QA\n- [ ] Alpha. <!-- qa:01.a -->\n- [ ] Beta. <!-- qa:02.b -->\n- [ ] Gamma. <!-- qa:03.c -->`;
    const utils = renderApp({
      ...withCoverage,
      getIssue: (n) => ({ number: n, htmlUrl: 'u', title: 't', body: resumeBody }),
    });
    // Connect with reduced mode ON.
    const input = utils.container.querySelector('#gh') as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'o/r/QA' } });
    fireEvent.click(utils.container.querySelector('input[type="checkbox"]') as HTMLInputElement);
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(utils.getByText(/Start a new run/)).toBeTruthy());
    // Resume the existing run instead of starting a new one.
    const resumeInput = utils.getByPlaceholderText('issue # or issue URL') as HTMLInputElement;
    fireEvent.input(resumeInput, { target: { value: '9' } });
    fireEvent.click(utils.getByText('Resume'));
    await waitFor(() => expect(utils.container.querySelector('.stepcard')).toBeTruthy());
    await flushEffects();
    // No pre-seed on resume: no banner, and the run starts on the first box Alpha
    // (nothing was auto-skipped past it), so a toggled-on resume cannot mass-skip.
    expect(utils.queryByText(/auto-skipped/)).toBeNull();
    expect(utils.container.querySelector('.stepcard')?.textContent).toContain('Alpha');
  });
});
