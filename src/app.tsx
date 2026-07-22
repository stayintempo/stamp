import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { RunDoc, Phase, StepGroup, Step } from './lib/types';
import {
  GithubClient,
  GithubError,
  loadRunDoc,
  parseSourceUrl,
  type IssueRef,
} from './lib/github';
import {
  applyStateToBody,
  canonicalDocUrl,
  countUnrepresentedSteps,
  emptyState,
  loadRunState,
  loadSettings,
  parseIssueBody,
  parseMarker,
  saveRunState,
  saveSettings,
  serializeIssueBody,
  setStep,
  stepState,
  summarize,
  STAMP_MARKER,
  type RunMeta,
  type RunState,
  type Settings,
  type StepStatus,
} from './lib/state';
import { createDebouncer } from './lib/debounce';
import { normalizeAppHost, suggestAppHost, type LinkContext } from './lib/links';
import { resolveKeyAction } from './lib/keys';
import { Markdown } from './components/Markdown';
import { SetupScreen } from './components/SetupScreen';
import { SettingsOverlay } from './components/SettingsOverlay';
import { RunHeader, type SyncStatus } from './components/RunHeader';
import { PhaseDrawer } from './components/PhaseDrawer';
import { StepCard } from './components/StepCard';
import { FinishView } from './components/FinishView';
import { Footer } from './components/Footer';

const VERSION = __APP_VERSION__;

/** Injectable so tests can supply a GithubClient wired to a mock fetch. */
export interface AppProps {
  createClient?: (token: string | undefined) => GithubClient;
}

type View = 'setup' | 'start' | 'run' | 'finish';

interface NavItem {
  phase: Phase;
  group: StepGroup;
  step: Step;
  phaseNumber: number;
  stepInPhase: number;
  phaseTotal: number;
}

function buildNav(doc: RunDoc): NavItem[] {
  const items: NavItem[] = [];
  doc.phases.forEach((phase, pi) => {
    const steps = phase.groups.flatMap((g) => g.steps.map((step) => ({ group: g, step })));
    steps.forEach(({ group, step }, si) => {
      items.push({
        phase,
        group,
        step,
        phaseNumber: pi + 1,
        stepInPhase: si + 1,
        phaseTotal: steps.length,
      });
    });
  });
  return items;
}

const emptySettings: Settings = { githubUrl: '', token: '', appHost: '' };

export function App({ createClient }: AppProps = {}) {
  const makeClient = createClient ?? ((token: string | undefined) => new GithubClient({ token }));

  const [view, setView] = useState<View>('setup');
  const [settings, setSettings] = useState<Settings>(loadSettings() ?? emptySettings);
  const [doc, setDoc] = useState<RunDoc | null>(null);
  const [runState, setRunState] = useState<RunState>(emptyState());
  const [issue, setIssue] = useState<IssueRef | null>(null);
  const [localOnly, setLocalOnly] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [discovered, setDiscovered] = useState<IssueRef[]>([]);
  const [resumeInput, setResumeInput] = useState('');
  const [posting, setPosting] = useState(false);
  const [posted, setPosted] = useState(false);
  const [postError, setPostError] = useState<string | undefined>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [phasesOpen, setPhasesOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('idle');
  const [syncNotice, setSyncNotice] = useState(0);
  const [shaMismatch, setShaMismatch] = useState<IssueRef | null>(null);

  const clientRef = useRef<GithubClient | null>(null);
  // Latest values for the debounced PATCH, which closes over stale state otherwise.
  const latest = useRef({ doc, runState, issue, settings });
  latest.current = { doc, runState, issue, settings };

  // Flush serialization + retry bookkeeping.
  const flushInFlight = useRef<Promise<void> | null>(null);
  const dirty = useRef(false);
  const lastBody = useRef<string | null>(null);

  const nav = useMemo(() => (doc ? buildNav(doc) : []), [doc]);
  const summary = useMemo(() => (doc ? summarize(doc, runState) : null), [doc, runState]);

  const meta = (d: RunDoc): RunMeta => ({
    docUrl: canonicalDocUrl(d.source),
    sha: d.source.sha,
    path: d.source.path,
    tool: `stamp@${VERSION}`,
  });

  // --- issue-body PATCH, debounced ~3s after the last change ---
  const patcher = useRef(
    createDebouncer(() => {
      void flushPatch();
    }, 3000),
  );

  /** One PATCH cycle: GET current body, merge state, PUT. Returns success. */
  async function patchOnce(): Promise<boolean> {
    const { doc: d, runState: rs, issue: iss } = latest.current;
    const client = clientRef.current;
    if (!d || !iss || !client) return true;
    try {
      const current = await client.getIssue(d.source.owner, d.source.repo, iss.number);
      lastBody.current = current.body;
      const merged = applyStateToBody(current.body, d, rs);
      await client.updateIssueBody(d.source.owner, d.source.repo, iss.number, merged);
      lastBody.current = merged;
      setSyncNotice(countUnrepresentedSteps(merged, d));
      setSyncStatus('synced');
      return true;
    } catch {
      // Non-fatal: localStorage holds the truth. Stay dirty so the next debounce
      // tick or the manual Retry re-attempts a full-state merge.
      dirty.current = true;
      setSyncStatus('error');
      return false;
    }
  }

  /**
   * Serialize flushes: only one PATCH cycle runs at a time; if more changes
   * arrive while it's in flight, run exactly once more when it settles (M1). A
   * failed cycle stops the loop (no hot retry) but leaves state dirty.
   */
  async function flushPatch(): Promise<void> {
    dirty.current = true;
    if (flushInFlight.current) return flushInFlight.current;
    const run = (async () => {
      while (dirty.current) {
        dirty.current = false;
        const ok = await patchOnce();
        if (!ok) break;
      }
    })();
    flushInFlight.current = run;
    try {
      await run;
    } finally {
      flushInFlight.current = null;
    }
  }

  function persist(next: RunState) {
    setRunState(next);
    // A new change means the last posted summary is now stale; re-enable posting.
    setPosted(false);
    setPostError(undefined);
    const d = latest.current.doc;
    if (!d) return;
    saveRunState(canonicalDocUrl(d.source), d.source.sha, issue?.number ?? null, next);
    if (issue && !localOnly) {
      dirty.current = true;
      setSyncStatus('pending');
      patcher.current.schedule();
    }
  }

  // Flush the last change if the tab is being hidden/closed within the debounce
  // window, using a keepalive PATCH so it survives teardown (H4c).
  useEffect(() => {
    if (view !== 'run' || !issue || localOnly) return;
    const flush = () => {
      const client = clientRef.current;
      const { doc: d, runState: rs, issue: iss } = latest.current;
      if (!client || !d || !iss) return;
      if (!dirty.current && !patcher.current.pending()) return;
      const base = lastBody.current;
      const body = base != null ? applyStateToBody(base, d, rs) : serializeIssueBody(d, rs, meta(d));
      client.patchIssueBodyKeepalive(d.source.owner, d.source.repo, iss.number, body);
      dirty.current = false;
    };
    const onVis = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, issue, localOnly]);

  // --- connect / load ---
  async function connect(s: Settings) {
    const normalized: Settings = { ...s, appHost: normalizeAppHost(s.appHost) };
    setSettings(normalized);
    saveSettings(normalized);
    setBusy(true);
    setError(undefined);
    try {
      const parsed = parseSourceUrl(normalized.githubUrl);
      const client = makeClient(normalized.token || undefined);
      clientRef.current = client;
      const loaded = await loadRunDoc(client, parsed);
      setDoc(loaded);
      // Suggest an app host from the doc if the field was left blank.
      if (!normalized.appHost) {
        const all = loaded.phases
          .flatMap((p) => [
            p.intro ?? '',
            ...p.groups.flatMap((g) => [g.intro ?? '', ...g.steps.map((st) => st.bodyMarkdown)]),
          ])
          .join('\n');
        const guess = suggestAppHost((loaded.preamble ?? '') + '\n' + all);
        if (guess) {
          const s2 = { ...normalized, appHost: guess };
          setSettings(s2);
          saveSettings(s2);
        }
      }
      // Best-effort discovery of resumable issues for THIS doc only.
      try {
        const canonical = canonicalDocUrl(loaded.source);
        setDiscovered(
          await client.listStampIssues(
            parsed.owner,
            parsed.repo,
            STAMP_MARKER,
            (body) => parseMarker(body)?.docUrl === canonical,
          ),
        );
      } catch {
        setDiscovered([]);
      }
      setView('start');
    } catch (e) {
      setError(e instanceof GithubError || e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function startNewIssue() {
    const d = doc;
    const client = clientRef.current;
    if (!d || !client) return;
    setBusy(true);
    setError(undefined);
    try {
      const date = new Date().toISOString().slice(0, 10);
      const title = `QA run: ${d.source.path || '/'} @ ${d.source.ref} (${date})`;
      const body = serializeIssueBody(d, emptyState(), meta(d));
      const created = await client.createIssue(d.source.owner, d.source.repo, title, body);
      setIssue(created);
      setLocalOnly(false);
      lastBody.current = created.body;
      const restored = loadRunState(canonicalDocUrl(d.source), d.source.sha, created.number);
      setRunState(restored);
      setSyncStatus('synced');
      setSyncNotice(0);
      setCurrentIndex(firstPending(d, restored));
      setView('run');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function resumeIssue() {
    const d = doc;
    const client = clientRef.current;
    if (!d || !client) return;
    const number = parseIssueNumber(resumeInput);
    if (number === undefined) {
      setError('Enter an issue number or a github.com issue URL.');
      return;
    }
    setBusy(true);
    setError(undefined);
    setShaMismatch(null);
    try {
      const found = await client.getIssue(d.source.owner, d.source.repo, number);
      validateAndResume(found, d, false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Validate a fetched issue before adopting it as run state (H2): it MUST carry
   * a STAMP marker whose docUrl/path match the loaded doc, or we refuse (a typo'd
   * number would otherwise let the next PATCH destructively rewrite a foreign
   * issue). A marker SHA differing from the loaded doc requires explicit
   * confirmation. Returns whether the run was adopted.
   */
  function validateAndResume(found: IssueRef, d: RunDoc, ignoreSha: boolean): boolean {
    const marker = parseMarker(found.body);
    if (!marker) {
      setError(`Issue #${found.number} is not a STAMP run (no marker found).`);
      return false;
    }
    const canonical = canonicalDocUrl(d.source);
    if (marker.docUrl !== canonical || marker.path !== d.source.path) {
      setError(
        `Issue #${found.number} was created for a different checklist (${marker.docUrl}). Refusing to overwrite it.`,
      );
      return false;
    }
    if (marker.sha !== d.source.sha && !ignoreSha) {
      setShaMismatch(found);
      return false;
    }

    // localStorage is the truth: if a local run exists for this (doc, sha, issue)
    // adopt it and schedule a PATCH to bring the issue up to date; otherwise read
    // state out of the issue body (H4b).
    const local = loadRunState(canonical, d.source.sha, found.number);
    const hasLocal = Object.keys(local.statuses).length > 0;
    const state = hasLocal ? local : parseIssueBody(found.body, d);

    setIssue(found);
    setLocalOnly(false);
    setRunState(state);
    saveRunState(canonical, d.source.sha, found.number, state);
    lastBody.current = found.body;
    setShaMismatch(null);
    setError(undefined);
    setCurrentIndex(firstPending(d, state));
    if (hasLocal) {
      dirty.current = true;
      setSyncStatus('pending');
      patcher.current.schedule();
    } else {
      setSyncStatus('synced');
      setSyncNotice(countUnrepresentedSteps(found.body, d));
    }
    setView('run');
    return true;
  }

  function startLocal() {
    const d = doc;
    if (!d) return;
    setLocalOnly(true);
    setIssue(null);
    setSyncStatus('idle');
    const restored = loadRunState(canonicalDocUrl(d.source), d.source.sha, null);
    setRunState(restored);
    setCurrentIndex(firstPending(d, restored));
    setView('run');
  }

  async function postSummary() {
    const d = doc;
    const client = clientRef.current;
    if (!d || !issue || !client || !summary) return;
    if (posting || posted) return; // guard double-post (M6)
    setPosting(true);
    setPostError(undefined);
    try {
      patcher.current.cancel();
      await flushPatch();
      await client.addComment(d.source.owner, d.source.repo, issue.number, summaryComment(d, runState));
      setPosted(true);
    } catch (e) {
      setPostError(e instanceof Error ? e.message : String(e));
    } finally {
      setPosting(false);
    }
  }

  // --- in-run settings (H5) ---
  function applySettingsInPlace(s: Settings) {
    const normalized: Settings = { ...s, appHost: normalizeAppHost(s.appHost) };
    setSettings(normalized);
    saveSettings(normalized);
    clientRef.current = makeClient(normalized.token || undefined);
    setSettingsOpen(false);
  }

  function reconnectFrom(s: Settings) {
    setSettingsOpen(false);
    void connect(s);
  }

  function clearToken() {
    const next = { ...latest.current.settings, token: '' };
    setSettings(next);
    saveSettings(next);
    clientRef.current = makeClient(undefined);
  }

  // --- step actions ---
  const current = nav[currentIndex];

  /**
   * Is an overlay currently the screen? One flag, derived in one place, so a new
   * overlay can't quietly reopen the hole where p/f/s marked a step through it.
   * Anything modal must be represented here — that is the whole contract.
   */
  const modalOpen = settingsOpen || phasesOpen || noteOpen;

  function advance() {
    if (!doc) return;
    const next = nextPending(currentIndex, runState, nav);
    setCurrentIndex(next);
  }

  /** Whether the open note editor was auto-opened by a Fail (so it advances). */
  const openedForFail = useRef(false);

  function applyVerdict(status: StepStatus) {
    if (!current) return;
    persist(setStep(runState, current.step.id, { status }));
    if (status === 'fail') {
      // A fail wants a note before moving on; advancing is deferred to close.
      openedForFail.current = true;
      setNoteOpen(true);
    } else {
      advance();
    }
  }

  function closeNote() {
    setNoteOpen(false);
    // Guarded: <dialog> also fires close when we hide it, re-entering here.
    if (openedForFail.current) {
      openedForFail.current = false;
      advance();
    }
  }

  function onNote(note: string) {
    if (!current) return;
    persist(setStep(runState, current.step.id, { note: note || undefined }));
  }

  /**
   * The run screen's ONLY keyboard listener, deliberately sited next to
   * `modalOpen`. It used to live in StepCard, which could only see its own note
   * dialog, so every overlay added since had to remember to opt out — and the
   * settings overlay never did. `actedOn` keeps a rapid second keypress from
   * re-marking a step the current render has already acted on (L8); it clears on
   * arrival at a step, so stepping back re-arms it.
   */
  const actedOn = useRef<string | null>(null);
  useEffect(() => {
    actedOn.current = null;
  }, [currentIndex]);

  useEffect(() => {
    if (view !== 'run' || modalOpen || !current) return;
    const handler = (e: KeyboardEvent) => {
      const action = resolveKeyAction(e, e.target as HTMLElement | null);
      if (!action) return;
      switch (action) {
        case 'pass':
        case 'skip':
        case 'fail':
          if (actedOn.current === current.step.id) return;
          actedOn.current = current.step.id;
          applyVerdict(action);
          break;
        case 'prev':
          setCurrentIndex((i) => Math.max(0, i - 1));
          break;
        case 'next':
          setCurrentIndex((i) => Math.min(nav.length - 1, i + 1));
          break;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, modalOpen, current, nav.length, runState]);

  function retrySync() {
    void flushPatch();
  }

  // ---------- render ----------
  if (view === 'setup' || !doc || !summary) {
    return (
      <main class="app">
        <SetupScreen
          initial={settings}
          busy={busy}
          error={error}
          onConnect={connect}
          onClearToken={clearToken}
        />
        <Footer />
      </main>
    );
  }

  if (view === 'start') {
    return (
      <main class="app">
        <StartPanel
          doc={doc}
          busy={busy}
          error={error}
          discovered={discovered}
          resumeInput={resumeInput}
          shaMismatch={shaMismatch}
          onResumeInput={setResumeInput}
          onNew={startNewIssue}
          onResume={resumeIssue}
          onConfirmResume={() => shaMismatch && validateAndResume(shaMismatch, doc, true)}
          onCancelResume={() => setShaMismatch(null)}
          onLocal={startLocal}
          onBack={() => setView('setup')}
        />
        <Footer />
      </main>
    );
  }

  if (view === 'finish') {
    return (
      <main class="app">
        <FinishView
          doc={doc}
          state={runState}
          summary={summary}
          issueUrl={issue?.htmlUrl}
          mirror={serializeIssueBody(doc, runState, meta(doc))}
          posting={posting}
          posted={posted}
          postError={postError}
          onPostSummary={postSummary}
          onBack={() => setView('run')}
        />
        <Footer />
      </main>
    );
  }

  // run view
  const linkCtx = current
    ? {
        appHost: settings.appHost || undefined,
        owner: doc.source.owner,
        repo: doc.source.repo,
        sha: doc.source.sha,
        filePath: current.group.filePath,
      }
    : undefined;

  return (
    <main class="app">
      <RunHeader
        doc={doc}
        summary={summary}
        issueUrl={issue?.htmlUrl}
        syncStatus={localOnly ? undefined : syncStatus}
        syncNotice={syncNotice}
        phase={
          current
            ? { number: current.phaseNumber, count: doc.phases.length, title: current.phase.title }
            : undefined
        }
        phasesOpen={phasesOpen}
        onOpenPhases={() => setPhasesOpen(true)}
        onRetrySync={retrySync}
        onSettings={() => setSettingsOpen(true)}
        onFinish={() => setView('finish')}
      />
      {doc.preamble && (
        <details class="preamble">
          <summary>Run overview</summary>
          <Markdown markdown={doc.preamble} ctx={preambleCtx(doc, settings.appHost)} />
        </details>
      )}
      {summary.totals.pending === 0 && (
        <div class="done-cue">
          All steps resolved —{' '}
          <button class="linkish" onClick={() => setView('finish')}>
            Finish ▸
          </button>
        </div>
      )}
      {current && linkCtx && (
        <StepCard
          key={current.step.id}
          phase={current.phase}
          step={current.step}
          positionText={`Phase ${current.phaseNumber} · Step ${current.stepInPhase}/${current.phaseTotal}`}
          status={stepState(runState, current.step.id).status}
          note={stepState(runState, current.step.id).note}
          linkCtx={linkCtx}
          issueUrl={issue?.htmlUrl}
          phaseIntro={current.stepInPhase === 1 ? current.phase.intro : undefined}
          groupIntro={
            current.group.steps[0]?.id === current.step.id ? current.group.intro : undefined
          }
          hasBack={currentIndex > 0}
          hasNext={currentIndex < nav.length - 1}
          noteOpen={noteOpen}
          onOpenNote={() => setNoteOpen(true)}
          onCloseNote={closeNote}
          onVerdict={applyVerdict}
          onNote={onNote}
          onBack={() => setCurrentIndex((i) => Math.max(0, i - 1))}
          onNext={() => setCurrentIndex((i) => Math.min(nav.length - 1, i + 1))}
        />
      )}
      {phasesOpen && (
        <PhaseDrawer
          doc={doc}
          state={runState}
          currentIndex={currentIndex}
          onJump={setCurrentIndex}
          onClose={() => setPhasesOpen(false)}
        />
      )}
      {settingsOpen && (
        <SettingsOverlay
          initial={settings}
          currentUrl={settings.githubUrl}
          busy={busy}
          onApplyInPlace={applySettingsInPlace}
          onReconnect={reconnectFrom}
          onClearToken={clearToken}
          onCancel={() => setSettingsOpen(false)}
        />
      )}
      <Footer />
    </main>
  );
}

// ---------------------------------------------------------------------------
// small inline pieces
// ---------------------------------------------------------------------------

/** Link context for the root README preamble (relative links resolve against it). */
function preambleCtx(doc: RunDoc, appHost: string): LinkContext {
  const root = doc.source.path.replace(/^\/+|\/+$/g, '');
  return {
    appHost: appHost || undefined,
    owner: doc.source.owner,
    repo: doc.source.repo,
    sha: doc.source.sha,
    filePath: root ? `${root}/README.md` : 'README.md',
  };
}


interface StartProps {
  doc: RunDoc;
  busy: boolean;
  error?: string;
  discovered: IssueRef[];
  resumeInput: string;
  shaMismatch: IssueRef | null;
  onResumeInput: (v: string) => void;
  onNew: () => void;
  onResume: () => void;
  onConfirmResume: () => void;
  onCancelResume: () => void;
  onLocal: () => void;
  onBack: () => void;
}

function StartPanel(p: StartProps) {
  return (
    <section class="pad stack">
      <div class="row" style={{ justifyContent: 'space-between' }}>
        <strong>{p.doc.source.owner}/{p.doc.source.repo}</strong>
        <button onClick={p.onBack}>◂ Settings</button>
      </div>
      <p class="hint">
        Loaded {p.doc.phases.length} phase(s), pinned to <code>{p.doc.source.sha.slice(0, 7)}</code>.
      </p>
      {p.error && <div class="error">{p.error}</div>}

      {p.shaMismatch && (
        <div class="warn-box stack">
          <p>
            Issue #{p.shaMismatch.number} was created against a different revision of this
            checklist. Resuming will sync your progress onto it anyway.
          </p>
          <div class="row" style={{ gap: '8px' }}>
            <button class="primary" disabled={p.busy} onClick={p.onConfirmResume}>
              Resume anyway
            </button>
            <button disabled={p.busy} onClick={p.onCancelResume}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <button class="primary" disabled={p.busy} onClick={p.onNew}>
        Start a new run (creates a GitHub issue)
      </button>

      <div class="field">
        <label>Resume an existing run</label>
        {p.discovered.length > 0 && (
          <select
            value=""
            onChange={(e) => p.onResumeInput((e.target as HTMLSelectElement).value)}
          >
            <option value="">Pick a discovered run…</option>
            {p.discovered.map((i) => (
              <option key={i.number} value={String(i.number)}>
                #{i.number} — {i.title}
              </option>
            ))}
          </select>
        )}
        <div class="row" style={{ marginTop: '8px' }}>
          <input
            value={p.resumeInput}
            onInput={(e) => p.onResumeInput((e.target as HTMLInputElement).value)}
            placeholder="issue # or issue URL"
          />
          <button disabled={p.busy} onClick={p.onResume}>
            Resume
          </button>
        </div>
      </div>

      <button disabled={p.busy} onClick={p.onLocal}>
        Run without issue sync (local only)
      </button>
    </section>
  );
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function firstPending(doc: RunDoc, state: RunState): number {
  const nav = buildNav(doc);
  const idx = nav.findIndex((n) => stepState(state, n.step.id).status === 'pending');
  return idx < 0 ? 0 : idx;
}

function nextPending(from: number, state: RunState, nav: NavItem[]): number {
  for (let i = from + 1; i < nav.length; i++) {
    if (stepState(state, nav[i].step.id).status === 'pending') return i;
  }
  // none after — fall back to the next index, clamped
  return Math.min(from + 1, nav.length - 1);
}

export function parseIssueNumber(input: string): number | undefined {
  const trimmed = input.trim();
  const fromUrl = trimmed.match(/\/issues\/(\d+)/);
  if (fromUrl) return Number(fromUrl[1]);
  if (/^#?\d+$/.test(trimmed)) return Number(trimmed.replace('#', ''));
  return undefined;
}

function summaryComment(doc: RunDoc, state: RunState): string {
  const s = summarize(doc, state);
  const lines = [`### STAMP run summary`, ''];
  lines.push(
    `**Totals:** ${s.totals.pass} pass · ${s.totals.fail} fail · ${s.totals.skip} skip · ${s.totals.pending} pending of ${s.totals.total}.`,
  );
  if (s.blockingFailures > 0) lines.push('', `⛔ **${s.blockingFailures} blocking failure(s)** — run does not pass.`);
  lines.push('', '| Phase | Pass | Fail | Skip | Pending |', '| --- | --- | --- | --- | --- |');
  for (const p of s.phases) {
    lines.push(`| ${p.title}${p.blocking ? ' [BLOCKING]' : ''} | ${p.pass} | ${p.fail} | ${p.skip} | ${p.pending} |`);
  }
  return lines.join('\n');
}
