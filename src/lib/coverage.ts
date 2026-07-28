// coverage.ts: read a QA/COVERAGE.md "Per-box ledger" into a stableId -> tag map.
//
// The ledger is the machine-readable side of the coverage contract. Its
// "## Per-box ledger" section is a 6-column markdown table:
//
//   | Sec | # | Box (short lead label) | Tag | Owner | ID |
//
// where Tag is one of CI SEED CHECK VISUAL BROWSER O365 OPERATOR and ID is the
// box's stable id (`qa:NN.slug`). Reduced mode joins on exact string equality
// between a step's stableId and the ID column. Parsing is fence- and
// heading-aware (like scanBodyTasks) and tolerant: a missing table, or a
// malformed row, yields no entry rather than throwing.

import type { RunDoc } from './types';
import { flattenSteps } from './parse';
import { setStep, stepState, type RunState, type StepState } from './state';

const FENCE_RE = /^\s*(`{3,}|~{3,})/;
const HEADING_RE = /^#{1,6}\s+(.*?)\s*#*\s*$/;
const LEDGER_HEADING_RE = /^#{1,6}\s+Per-box ledger\b/i;

/** Tags whose boxes a machine already covers (kept identical to seed-qa's set). */
export const MACHINE_COVERED_TAGS = new Set(['CI', 'SEED']);

/** Strip a single pair of surrounding backticks and trim, so `` `qa:01.x` `` == `qa:01.x`. */
function cell(raw: string): string {
  return raw.trim().replace(/^`(.*)`$/, '$1').trim();
}

/** A markdown table separator row: every cell is dashes/colons only. */
function isSeparatorRow(cells: string[]): boolean {
  return cells.every((c) => /^:?-+:?$/.test(c.trim()));
}

/**
 * Parse the "## Per-box ledger" table into a Map of stableId -> tag (tag
 * uppercased). Rows outside the ledger section, header/separator rows, and rows
 * that are not exactly 6 columns or lack an ID are skipped. Returns an empty map
 * when no ledger section or table is present.
 */
export function parseCoverageLedger(markdown: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  let inFence = false;
  let fenceRun = '';
  let active = false; // inside the "Per-box ledger" section

  for (const line of lines) {
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

    const heading = line.match(HEADING_RE);
    if (heading) {
      // Entering the ledger section, or leaving it at the next heading of any level.
      active = LEDGER_HEADING_RE.test(line);
      continue;
    }
    if (!active) continue;

    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    // Split a `| a | b | ... |` row into its inner cells.
    const parts = trimmed.split('|');
    const inner = parts.slice(1, parts.length - 1);
    const cells = inner.map(cell);
    if (cells.length !== 6) continue; // malformed width -> skip
    if (isSeparatorRow(inner)) continue;
    const tag = cells[3];
    const id = cells[5];
    // Skip the header row and anything without a usable id/tag.
    if (!id || id.toLowerCase() === 'id') continue;
    if (!tag) continue;
    out.set(id, tag.toUpperCase());
  }
  return out;
}

/**
 * Pre-seed a run for reduced mode: every machine-covered box (tag CI or SEED)
 * that is still `pending` becomes an auto-skip carrying a provisional `auto:`
 * note. Never overwrites an existing status, so a tester verdict or a seed-qa
 * check already imported into the state survives. Returns the new state and the
 * number of boxes auto-skipped (for the banner).
 */
export function preSeedReduced(
  doc: RunDoc,
  state: RunState,
  coverage: Map<string, string>,
): { state: RunState; count: number } {
  let next = state;
  let count = 0;
  for (const { step } of flattenSteps(doc)) {
    if (!step.stableId) continue;
    const tag = coverage.get(step.stableId);
    if (!tag || !MACHINE_COVERED_TAGS.has(tag)) continue;
    if (stepState(next, step.id).status !== 'pending') continue; // never overwrite
    const seeded: StepState = { status: 'skip', note: `auto: machine-covered (${tag})` };
    next = setStep(next, step.id, seeded);
    count++;
  }
  return { state: next, count };
}
