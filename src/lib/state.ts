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

// ---------------------------------------------------------------------------
// serialization
// ---------------------------------------------------------------------------

const flattenNote = (note: string): string => note.replace(/\s*\n\s*/g, ' ').trim();

/** The step line + its note sub-bullets for a given state. */
export function renderStepLines(label: string, st: StepState): string[] {
  const note = st.note ? flattenNote(st.note) : '';
  switch (st.status) {
    case 'pass':
      return note ? [`- [x] ${label}`, `  - 📝 ${note}`] : [`- [x] ${label}`];
    case 'fail':
      return [`- [x] ${label}`, `  - ❌ FAIL: ${note}`];
    case 'skip':
      return [`- [ ] ${label}`, note ? `  - ⏭ skipped — ${note}` : `  - ⏭ skipped`];
    case 'pending':
    default:
      return note ? [`- [ ] ${label}`, `  - 📝 ${note}`] : [`- [ ] ${label}`];
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
        out.push(...renderStepLines(step.label, stepState(state, step.id)));
      }
    }
    out.push('');
  }
  return out.join('\n').trimEnd() + '\n';
}

interface BodyTask {
  lineIndex: number;
  checked: boolean;
  label: string;
}

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
    if (m) tasks.push({ lineIndex: i, checked: m[1].toLowerCase() === 'x', label: m[2].trim() });
  }
  return tasks;
}

/**
 * Anchor doc steps to body task lines by EXACT label text. Among duplicate
 * labels the k-th doc step maps to the k-th body line with that label (ordinal
 * disambiguation; position is only a tiebreak within a label). Body lines with
 * no matching doc label stay foreign/untouched; doc steps with no matching line
 * stay unrepresented. Returns the line-index → step map and the matched-step set.
 */
function matchStepsToTasks(
  flat: Array<{ step: Step }>,
  tasks: BodyTask[],
): { taskToStep: Map<number, { step: Step }>; matchedSteps: Set<number> } {
  const byLabel = new Map<string, BodyTask[]>();
  for (const t of tasks) {
    const list = byLabel.get(t.label);
    if (list) list.push(t);
    else byLabel.set(t.label, [t]);
  }
  const cursor = new Map<string, number>();
  const taskToStep = new Map<number, { step: Step }>();
  const matchedSteps = new Set<number>();
  flat.forEach((entry, si) => {
    const list = byLabel.get(entry.step.label.trim());
    if (!list) return;
    const k = cursor.get(entry.step.label.trim()) ?? 0;
    if (k < list.length) {
      taskToStep.set(list[k].lineIndex, entry);
      cursor.set(entry.step.label.trim(), k + 1);
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
  const { taskToStep } = matchStepsToTasks(flat, tasks);
  const out: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const entry = taskToStep.get(i);
    if (!entry) {
      out.push(lines[i]);
      continue;
    }
    const label = lines[i].match(TASK_LINE_RE)![2];
    out.push(...renderStepLines(label, stepState(state, entry.step.id)));
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
        status = 'skip';
        if (skip[1]) note = skip[1].trim() || undefined;
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
