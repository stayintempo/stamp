// state.ts — run state, localStorage persistence, and issue-body (de)serialization.
//
// The GitHub issue body is the shared, auditable record. It is a human-readable
// task-list mirror of the RunDoc plus a metadata marker. We keep three body
// operations:
//   serializeIssueBody  - generate a fresh body (issue creation, local copy)
//   applyStateToBody    - merge local state onto an existing body (the PATCH path,
//                         preserving foreign lines and hand-edited labels)
//   parseIssueBody      - read state back out of a body (resume)
// Steps are aligned to the doc by POSITION (the Nth top-level task line == the
// Nth step in run order), so hand-renamed labels still map and never crash.

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

/**
 * Merge local state onto an existing body. Rewrites each step's checkbox and
 * note bullets in place (keyed by position) and preserves everything else —
 * foreign lines, prose, and hand-edited step labels.
 */
export function applyStateToBody(existingBody: string, doc: RunDoc, state: RunState): string {
  const flat = flattenSteps(doc);
  const lines = existingBody.split('\n');
  const out: string[] = [];
  let taskIndex = 0;

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(TASK_LINE_RE);
    if (!m) {
      out.push(lines[i]);
      continue;
    }
    const entry = flat[taskIndex];
    taskIndex++;
    if (!entry) {
      // Extra task line beyond the doc — leave it untouched.
      out.push(lines[i]);
      continue;
    }
    const label = m[2];
    out.push(...renderStepLines(label, stepState(state, entry.step.id)));
    // Drop the old note bullets that belonged to this step.
    let j = i + 1;
    while (j < lines.length && NOTE_BULLET_RE.test(lines[j])) j++;
    i = j - 1;
  }
  return out.join('\n');
}

/** Read run state back out of an issue body, aligned by position to the doc. */
export function parseIssueBody(body: string, doc: RunDoc): RunState {
  const flat = flattenSteps(doc);
  const lines = body.split('\n');
  const statuses: Record<string, StepState> = {};
  let taskIndex = 0;

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(TASK_LINE_RE);
    if (!m) continue;
    const entry = flat[taskIndex];
    taskIndex++;
    if (!entry) continue;

    const checked = m[1].toLowerCase() === 'x';
    let status: StepStatus = checked ? 'pass' : 'pending';
    let note: string | undefined;

    // Inspect the immediately-following note bullets.
    let j = i + 1;
    while (j < lines.length && NOTE_BULLET_RE.test(lines[j])) {
      const nl = lines[j].trim();
      const fail = nl.match(/^-\s+❌\s*FAIL:\s*(.*)$/u);
      const skip = nl.match(/^-\s+⏭\s*skipped(?:\s*—\s*(.*))?$/u);
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
