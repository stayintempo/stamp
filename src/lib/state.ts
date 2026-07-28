// state.ts — run state, localStorage persistence, and issue-body (de)serialization.
//
// The GitHub issue body is the shared, auditable record. It is a human-readable
// task-list mirror of the RunDoc plus a metadata marker. We keep three body
// operations:
//   serializeIssueBody  - generate a fresh body (issue creation, local copy)
//   applyStateToBody    - merge local state onto an existing body (the PATCH path,
//                         preserving foreign lines and hand-edited labels)
//   parseIssueBody      - read state back out of a body (resume)
// Steps are aligned to the doc by LABEL text (the k-th line with a given label
// maps to the k-th step with that label), skipping fenced regions. Foreign task
// lines a human inserted, and hand-renamed labels, stay untouched rather than
// being clobbered by a position that shifted; steps with no matching line are
// surfaced as "unrepresented" (countUnrepresentedSteps), never crash.

import type { RunDoc, Step } from './types';
import { flattenSteps } from './parse';

export type StepStatus = 'pending' | 'pass' | 'fail' | 'skip';

export interface StepState {
  status: StepStatus;
  note?: string;
}

export interface RunState {
  /** Only steps that differ from the default (pending, no note) are stored. */
  statuses: Record<string, StepState>;
}

export interface RunMeta {
  docUrl: string;
  sha: string;
  path: string;
  /** e.g. "stamp@0.1.0" — pins the tool version alongside the doc SHA. */
  tool: string;
}

export const STAMP_MARKER = 'stamp:v1';

const NOTE_BULLET_RE = /^\s+-\s+(?:📝|❌\s*FAIL:|⏭\s*skipped)/u;
const TASK_LINE_RE = /^- \[([ xX])\] (.*)$/;
const FENCE_RE = /^\s*(`{3,}|~{3,})/;

/** Normalize CRLF/CR to LF. GitHub web-UI edits store CRLF; without this the
 *  `$`-anchored task/note regexes never match and sync silently no-ops. */
const toLF = (s: string): string => s.replace(/\r\n?/g, '\n');

export const emptyState = (): RunState => ({ statuses: {} });

export const stepState = (state: RunState, id: string): StepState =>
  state.statuses[id] ?? { status: 'pending' };

export function setStep(state: RunState, id: string, next: Partial<StepState>): RunState {
  const current = stepState(state, id);
  const merged: StepState = { ...current, ...next };
  const statuses = { ...state.statuses };
  if (merged.status === 'pending' && !merged.note) delete statuses[id];
  else statuses[id] = merged;
  return { statuses };
}

/** A local status is provisional: pending, or an `auto:` reduced-mode pre-seed. */
export function isProvisional(st: StepState): boolean {
  return st.status === 'pending' || (st.note?.startsWith('auto:') ?? false);
}

/**
 * Reconcile a resumed issue's state with local state for the external check-off
 * coexistence rules. The tester's own explicit verdicts (any non-`auto:` local
 * status) win, as before. Where local is only provisional (pending or an `auto:`
 * pre-seed), a non-pending issue status is adopted so external evidence (a
 * checked box with a `📝` provenance note) upgrades an auto-skip. Issue statuses
 * for steps with no local entry are kept.
 */
export function reconcileResumeState(issue: RunState, local: RunState): RunState {
  const statuses: Record<string, StepState> = { ...issue.statuses };
  for (const [id, st] of Object.entries(local.statuses)) {
    if (isProvisional(st)) {
      // Keep the provisional status only when the issue side has nothing better;
      // otherwise the issue (external evidence) wins and upgrades it.
      if (!statuses[id]) statuses[id] = st;
    } else {
      statuses[id] = st; // explicit tester verdict always wins
    }
  }
  return { statuses };
}

// ---------------------------------------------------------------------------
// serialization
// ---------------------------------------------------------------------------

const flattenNote = (note: string): string => note.replace(/\s*\n\s*/g, ' ').trim();

/**
 * The step line + its note sub-bullets for a given state. When the step has a
 * stable id, append it as a trailing HTML comment on the task line so resume can
 * match by id (invisible in GitHub's rendered issue, so the tester sees nothing).
 */
export function renderStepLines(label: string, st: StepState, stableId?: string): string[] {
  const note = st.note ? flattenNote(st.note) : '';
  const task = `${label}${stableId ? ` <!-- ${stableId} -->` : ''}`;
  switch (st.status) {
    case 'pass':
      return note ? [`- [x] ${task}`, `  - 📝 ${note}`] : [`- [x] ${task}`];
    case 'fail':
      return [`- [x] ${task}`, `  - ❌ FAIL: ${note}`];
    case 'skip':
      return [`- [ ] ${task}`, note ? `  - ⏭ skipped — ${note}` : `  - ⏭ skipped`];
    case 'pending':
    default:
      return note ? [`- [ ] ${task}`, `  - 📝 ${note}`] : [`- [ ] ${task}`];
  }
}

export function formatMarker(meta: RunMeta): string {
  return `<!-- ${STAMP_MARKER} ${JSON.stringify(meta)} -->`;
}

/** Generate a fresh issue body from the doc + state. */
export function serializeIssueBody(doc: RunDoc, state: RunState, meta: RunMeta): string {
  const out: string[] = [formatMarker(meta), ''];
  out.push(`STAMP run for \`${meta.path || '/'}\` @ \`${doc.source.ref}\` (${doc.source.sha.slice(0, 7)}).`, '');
  for (const phase of doc.phases) {
    out.push(`## ${phase.title}${phase.badge ? ` [${phase.badge}]` : ''}`, '');
    for (const group of phase.groups) {
      for (const step of group.steps) {
        out.push(...renderStepLines(step.label, stepState(state, step.id), step.stableId));
      }
    }
    out.push('');
  }
  return out.join('\n').trimEnd() + '\n';
}

interface BodyTask {
  lineIndex: number;
  checked: boolean;
  /** Label text with any trailing stable-id comment removed. */
  label: string;
  /** Verbatim token captured from a trailing `<!-- ... -->` on the task line. */
  stableId?: string;
}

// Same generic shape as parse.ts STEP_ID_RE: a trailing HTML comment carrying a
// single whitespace-free token. Captured off the task line so it neither
// corrupts exact-label matching nor renders in the issue. A token that swallowed
// an embedded `-->` (e.g. `<!-- a-->b -->`) is rejected, mirroring the parser, so
// it is never re-emitted to leak visible text past the terminator.
const BODY_ID_RE = /\s*<!--\s*(\S+)\s*-->\s*$/;
const isUsableIdToken = (token: string): boolean => !token.includes('-->');

/** Scan top-level task lines, skipping fenced code regions so a `- [ ]` inside
 *  a fence is never treated as a tracked task. */
function scanBodyTasks(lines: string[]): BodyTask[] {
  const tasks: BodyTask[] = [];
  let inFence = false;
  let fenceRun = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fm = line.match(FENCE_RE);
    if (fm) {
      const run = fm[1];
      const rest = line.slice(fm[0].length).trim();
      if (!inFence) {
        inFence = true;
        fenceRun = run;
      } else if (run[0] === fenceRun[0] && run.length >= fenceRun.length && rest === '') {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;
    const m = line.match(TASK_LINE_RE);
    if (m) {
      let label = m[2].trim();
      let stableId: string | undefined;
      const idm = label.match(BODY_ID_RE);
      if (idm && isUsableIdToken(idm[1])) {
        stableId = idm[1];
        label = label.slice(0, idm.index).trimEnd();
      }
      tasks.push({ lineIndex: i, checked: m[1].toLowerCase() === 'x', label, ...(stableId ? { stableId } : {}) });
    }
  }
  return tasks;
}

/**
 * Anchor doc steps to body task lines. Two passes:
 *
 *  1. By STABLE ID: a doc step with a stableId claims the body task carrying the
 *     same id (exact string equality). This is what survives a label/prose edit
 *     of the box, the fix for the resume-orphan bug. Only the FIRST doc step
 *     with a given id matches by id; any later duplicate falls through to the
 *     label pass, so a non-unique id can never silently mis-map the rest.
 *  2. By EXACT label (the long-standing fallback), over the steps and body tasks
 *     not already claimed in pass 1. Among duplicate labels the k-th remaining
 *     doc step maps to the k-th remaining body line with that label (ordinal
 *     disambiguation; position is only a tiebreak within a label).
 *
 * Body lines with no match stay foreign/untouched; doc steps with no match stay
 * unrepresented. Returns the line-index → step map and the matched-step set.
 */
function matchStepsToTasks(
  flat: Array<{ step: Step }>,
  tasks: BodyTask[],
): { taskToStep: Map<number, { step: Step }>; matchedSteps: Set<number> } {
  const taskToStep = new Map<number, { step: Step }>();
  const matchedSteps = new Set<number>();
  const usedTasks = new Set<number>();

  // Pass 1: stable id.
  const byId = new Map<string, BodyTask[]>();
  for (const t of tasks) {
    if (!t.stableId) continue;
    const list = byId.get(t.stableId);
    if (list) list.push(t);
    else byId.set(t.stableId, [t]);
  }
  const claimedDocIds = new Set<string>();
  flat.forEach((entry, si) => {
    const sid = entry.step.stableId;
    if (!sid || claimedDocIds.has(sid)) return; // first doc step per id only
    claimedDocIds.add(sid);
    const list = byId.get(sid);
    if (!list || list.length === 0) return;
    const t = list[0];
    taskToStep.set(t.lineIndex, entry);
    usedTasks.add(t.lineIndex);
    matchedSteps.add(si);
  });

  // Pass 2: exact label, over what pass 1 left unclaimed.
  const byLabel = new Map<string, BodyTask[]>();
  for (const t of tasks) {
    if (usedTasks.has(t.lineIndex)) continue;
    const list = byLabel.get(t.label);
    if (list) list.push(t);
    else byLabel.set(t.label, [t]);
  }
  const cursor = new Map<string, number>();
  flat.forEach((entry, si) => {
    if (matchedSteps.has(si)) return;
    const key = entry.step.label.trim();
    const list = byLabel.get(key);
    if (!list) return;
    const k = cursor.get(key) ?? 0;
    if (k < list.length) {
      taskToStep.set(list[k].lineIndex, entry);
      cursor.set(key, k + 1);
      matchedSteps.add(si);
    }
  });
  return { taskToStep, matchedSteps };
}

/**
 * Merge local state onto an existing body. Rewrites the checkbox + note bullets
 * of each label-matched step in place and preserves everything else — foreign
 * task lines and their sub-bullets, prose, comments, and fenced regions.
 */
export function applyStateToBody(existingBody: string, doc: RunDoc, state: RunState): string {
  const flat = flattenSteps(doc);
  const lines = toLF(existingBody).split('\n');
  const tasks = scanBodyTasks(lines);
  const taskByLine = new Map(tasks.map((t) => [t.lineIndex, t]));
  const { taskToStep } = matchStepsToTasks(flat, tasks);
  const out: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const entry = taskToStep.get(i);
    if (!entry) {
      out.push(lines[i]);
      continue;
    }
    // Keep the body line's own (comment-stripped) label so a hand-edited label
    // is preserved, and re-emit the step's stable-id comment (upgrading a
    // pre-id issue line to carry the id going forward).
    const label = taskByLine.get(i)?.label ?? lines[i].match(TASK_LINE_RE)![2];
    out.push(...renderStepLines(label, stepState(state, entry.step.id), entry.step.stableId));
    // Drop the old note bullets that belonged to this matched step only.
    let j = i + 1;
    while (j < lines.length && NOTE_BULLET_RE.test(lines[j])) j++;
    i = j - 1;
  }
  return out.join('\n');
}

/** Read run state back out of an issue body, aligned by label to the doc. */
export function parseIssueBody(body: string, doc: RunDoc): RunState {
  const flat = flattenSteps(doc);
  const lines = toLF(body).split('\n');
  const tasks = scanBodyTasks(lines);
  const { taskToStep } = matchStepsToTasks(flat, tasks);
  const statuses: Record<string, StepState> = {};

  for (const t of tasks) {
    const entry = taskToStep.get(t.lineIndex);
    if (!entry) continue;

    let status: StepStatus = t.checked ? 'pass' : 'pending';
    let note: string | undefined;

    // Inspect the immediately-following note bullets.
    let j = t.lineIndex + 1;
    while (j < lines.length && NOTE_BULLET_RE.test(lines[j])) {
      const nl = lines[j].trim();
      const fail = nl.match(/^-\s+❌\s*FAIL:\s*(.*)$/u);
      // Tolerate an em dash OR a hyphen after "skipped" (L7).
      const skip = nl.match(/^-\s+⏭\s*skipped(?:\s*[—-]\s*(.*))?$/u);
      const plain = nl.match(/^-\s+📝\s*(.*)$/u);
      if (fail) {
        status = 'fail';
        note = fail[1].trim() || undefined;
      } else if (skip) {
        // A `⏭ skipped` bullet only downgrades an UNCHECKED line. On a checked
        // (`- [x]`) line the box is a pass (or fail); a lingering skip bullet, such
        // as STAMP's own auto-skip that the external writer left behind when it
        // flipped the box, must never turn the pass back into a skip. The note, if
        // any, comes from a later `📝` bullet.
        if (!t.checked) {
          status = 'skip';
          if (skip[1]) note = skip[1].trim() || undefined;
        }
      } else if (plain) {
        note = plain[1].trim() || undefined;
      }
      j++;
    }

    if (status !== 'pending' || note) statuses[entry.step.id] = { status, note };
  }

  return { statuses };
}

/** How many doc steps have no matching task line in the body (for the sync notice). */
export function countUnrepresentedSteps(body: string, doc: RunDoc): number {
  const flat = flattenSteps(doc);
  const tasks = scanBodyTasks(toLF(body).split('\n'));
  const { matchedSteps } = matchStepsToTasks(flat, tasks);
  return flat.length - matchedSteps.size;
}

/** Extract the metadata block if the body carries the STAMP marker. */
export function parseMarker(body: string): RunMeta | undefined {
  const m = body.match(/<!--\s*stamp:v1\s+(\{[\s\S]*?\})\s*-->/);
  if (!m) return undefined;
  try {
    return JSON.parse(m[1]) as RunMeta;
  } catch {
    return undefined;
  }
}

export const hasStampMarker = (body: string): boolean => body.includes(STAMP_MARKER);

// ---------------------------------------------------------------------------
// summary (finish view)
// ---------------------------------------------------------------------------

export interface PhaseSummary {
  id: string;
  title: string;
  blocking: boolean;
  pass: number;
  fail: number;
  skip: number;
  pending: number;
  total: number;
}

export interface RunSummary {
  phases: PhaseSummary[];
  totals: { pass: number; fail: number; skip: number; pending: number; total: number };
  blockingFailures: number;
}

export function summarize(doc: RunDoc, state: RunState): RunSummary {
  const phases: PhaseSummary[] = [];
  const totals = { pass: 0, fail: 0, skip: 0, pending: 0, total: 0 };
  let blockingFailures = 0;

  for (const phase of doc.phases) {
    const ps: PhaseSummary = {
      id: phase.id,
      title: phase.title,
      blocking: phase.badge === 'BLOCKING',
      pass: 0,
      fail: 0,
      skip: 0,
      pending: 0,
      total: 0,
    };
    for (const group of phase.groups) {
      for (const step of group.steps) {
        const st = stepState(state, step.id).status;
        ps[st]++;
        ps.total++;
        totals[st]++;
        totals.total++;
      }
    }
    if (ps.blocking) blockingFailures += ps.fail;
    phases.push(ps);
  }

  return { phases, totals, blockingFailures };
}

/** The clipboard reference line for the screenshot-via-issue bridge. */
export function screenshotReference(phaseTitle: string, step: Step): string {
  return `Screenshot for: ${phaseTitle} / ${step.label}`;
}

// ---------------------------------------------------------------------------
// localStorage persistence
// ---------------------------------------------------------------------------

export interface Settings {
  githubUrl: string;
  token: string;
  appHost: string;
  /**
   * Reduced run: auto-skip machine-covered (CI/SEED) boxes at run start. Optional
   * so settings saved before this feature load as `off`; absent or false is off.
   */
  reducedMode?: boolean;
}

const SETTINGS_KEY = 'stamp:settings';
const runKey = (docUrl: string, sha: string, issueNumber: number | null): string =>
  `stamp:run:${docUrl}#${sha}#${issueNumber ?? 'local'}`;

/**
 * One canonical identity string for a doc, independent of how the tester typed
 * the URL. `owner/repo/QA` and its tree URL collapse to the same value so they
 * share localStorage state and match the same marker (owner/repo lowercased —
 * GitHub is case-insensitive there; path kept verbatim). Excludes ref/sha: the
 * SHA is tracked separately as the revision pin.
 */
export function canonicalDocUrl(source: {
  owner: string;
  repo: string;
  path: string;
}): string {
  const path = source.path.replace(/^\/+|\/+$/g, '');
  return `${source.owner.toLowerCase()}/${source.repo.toLowerCase()}${path ? `/${path}` : ''}`;
}

function safeStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function loadSettings(): Settings | undefined {
  const raw = safeStorage()?.getItem(SETTINGS_KEY);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as Settings;
  } catch {
    return undefined;
  }
}

export function saveSettings(s: Settings): void {
  safeStorage()?.setItem(SETTINGS_KEY, JSON.stringify(s));
}

export function loadRunState(docUrl: string, sha: string, issueNumber: number | null): RunState {
  const raw = safeStorage()?.getItem(runKey(docUrl, sha, issueNumber));
  if (!raw) return emptyState();
  try {
    return JSON.parse(raw) as RunState;
  } catch {
    return emptyState();
  }
}

export function saveRunState(
  docUrl: string,
  sha: string,
  issueNumber: number | null,
  state: RunState,
): void {
  safeStorage()?.setItem(runKey(docUrl, sha, issueNumber), JSON.stringify(state));
}
