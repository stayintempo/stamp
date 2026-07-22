import { useMemo, useRef, useState } from 'preact/hooks';
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
  emptyState,
  loadRunState,
  loadSettings,
  parseIssueBody,
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
import { suggestAppHost, type LinkContext } from './lib/links';
import { Markdown } from './components/Markdown';
import { SetupScreen } from './components/SetupScreen';
import { RunHeader } from './components/RunHeader';
import { PhaseNav } from './components/PhaseNav';
import { StepCard } from './components/StepCard';
import { FinishView } from './components/FinishView';

const VERSION = __APP_VERSION__;

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

export function App() {
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

  const clientRef = useRef<GithubClient | null>(null);
  // Latest values for the debounced PATCH, which closes over stale state otherwise.
  const latest = useRef({ doc, runState, issue, settings });
  latest.current = { doc, runState, issue, settings };

  const nav = useMemo(() => (doc ? buildNav(doc) : []), [doc]);
  const summary = useMemo(() => (doc ? summarize(doc, runState) : null), [doc, runState]);

  const meta = (d: RunDoc): RunMeta => ({
    docUrl: settings.githubUrl,
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

  async function flushPatch() {
    const { doc: d, runState: rs, issue: iss } = latest.current;
    const client = clientRef.current;
    if (!d || !iss || !client) return;
    try {
      const current = await client.getIssue(d.source.owner, d.source.repo, iss.number);
      const merged = applyStateToBody(current.body, d, rs);
      await client.updateIssueBody(d.source.owner, d.source.repo, iss.number, merged);
    } catch {
      // Network hiccups are non-fatal: localStorage holds the truth and the
      // next change re-attempts a full-state merge.
    }
  }

  function persist(next: RunState) {
    setRunState(next);
    const d = latest.current.doc;
    if (!d) return;
    saveRunState(settings.githubUrl, d.source.sha, issue?.number ?? null, next);
    if (issue && !localOnly) patcher.current.schedule();
  }

  // --- connect / load ---
  async function connect(s: Settings) {
    setSettings(s);
    saveSettings(s);
    setBusy(true);
    setError(undefined);
    try {
      const parsed = parseSourceUrl(s.githubUrl);
      const client = new GithubClient({ token: s.token || undefined });
      clientRef.current = client;
      const loaded = await loadRunDoc(client, parsed);
      setDoc(loaded);
      // Suggest an app host from the doc if the field was left blank.
      if (!s.appHost) {
        const all = loaded.phases
          .flatMap((p) => [
            p.intro ?? '',
            ...p.groups.flatMap((g) => [g.intro ?? '', ...g.steps.map((st) => st.bodyMarkdown)]),
          ])
          .join('\n');
        const guess = suggestAppHost((loaded.preamble ?? '') + '\n' + all);
        if (guess) {
          const s2 = { ...s, appHost: guess };
          setSettings(s2);
          saveSettings(s2);
        }
      }
      // Best-effort discovery of resumable issues.
      try {
        setDiscovered(await client.listStampIssues(parsed.owner, parsed.repo, STAMP_MARKER));
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
      const restored = loadRunState(settings.githubUrl, d.source.sha, created.number);
      setRunState(restored);
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
    try {
      const found = await client.getIssue(d.source.owner, d.source.repo, number);
      const parsed = parseIssueBody(found.body, d);
      setIssue(found);
      setLocalOnly(false);
      setRunState(parsed);
      saveRunState(settings.githubUrl, d.source.sha, found.number, parsed);
      setCurrentIndex(firstPending(d, parsed));
      setView('run');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function startLocal() {
    const d = doc;
    if (!d) return;
    setLocalOnly(true);
    setIssue(null);
    const restored = loadRunState(settings.githubUrl, d.source.sha, null);
    setRunState(restored);
    setCurrentIndex(firstPending(d, restored));
    setView('run');
  }

  async function postSummary() {
    const d = doc;
    const client = clientRef.current;
    if (!d || !issue || !client || !summary) return;
    setPosting(true);
    try {
      patcher.current.flush();
      await flushPatch();
      await client.addComment(d.source.owner, d.source.repo, issue.number, summaryComment(d, runState));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPosting(false);
    }
  }

  // --- step actions ---
  const current = nav[currentIndex];

  function advance() {
    if (!doc) return;
    const next = nextPending(currentIndex, runState, nav);
    setCurrentIndex(next);
  }

  function onVerdict(status: StepStatus) {
    if (!current) return;
    persist(setStep(runState, current.step.id, { status }));
  }

  function onNote(note: string) {
    if (!current) return;
    persist(setStep(runState, current.step.id, { note: note || undefined }));
  }

  // ---------- render ----------
  if (view === 'setup' || !doc || !summary) {
    return (
      <main class="app">
        <SetupScreen initial={settings} busy={busy} error={error} onConnect={connect} />
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
          onResumeInput={setResumeInput}
          onNew={startNewIssue}
          onResume={resumeIssue}
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
        onSettings={() => setView('setup')}
        onFinish={() => setView('finish')}
      />
      {doc.preamble && (
        <details class="preamble">
          <summary>Run overview</summary>
          <Markdown markdown={doc.preamble} ctx={preambleCtx(doc, settings.appHost)} />
        </details>
      )}
      <PhaseNav doc={doc} state={runState} currentIndex={currentIndex} onJump={setCurrentIndex} />
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
          onVerdict={(s) => {
            onVerdict(s);
            if (s !== 'fail') advance();
          }}
          onNote={onNote}
          onFailResolved={advance}
          onBack={() => setCurrentIndex((i) => Math.max(0, i - 1))}
          onNext={() => setCurrentIndex((i) => Math.min(nav.length - 1, i + 1))}
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

function Footer() {
  return (
    <footer class="appfoot">
      <span class="brand">STAMP</span>
      <span>v{VERSION}</span>
    </footer>
  );
}

interface StartProps {
  doc: RunDoc;
  busy: boolean;
  error?: string;
  discovered: IssueRef[];
  resumeInput: string;
  onResumeInput: (v: string) => void;
  onNew: () => void;
  onResume: () => void;
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

function parseIssueNumber(input: string): number | undefined {
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
