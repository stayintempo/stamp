// coverage.ts: read a QA/COVERAGE.md "Per-box ledger" into a stableId -> entry map.
//
// The ledger is the machine-readable side of the coverage contract. Its
// "## Per-box ledger" section is a markdown table whose columns are found BY
// HEADER NAME, not by position:
//
//   | Sec | # | Box (short lead label) | Tag | Owner | ID | Role |
//
// Only Tag and ID are required; Role is optional, so a ledger written before the
// Role column existed still parses. Columns may appear in any order, and a ledger
// that appends an eighth column later cannot break this parser. (It broke once:
// a fixed six-column width check silently dropped every row of a seven-column
// ledger, so reduced mode auto-skipped nothing while looking healthy.)
//
// Tag is one of CI SEED CHECK VISUAL BROWSER O365 OPERATOR. Role is the execution
// role: `-` (or an absent column) means "the tag's default", resolved eagerly by
// effectiveRole so downstream code never re-derives it. ID is the box's stable id,
// and may hold either the full comment token a step parses to (e.g. `ns:NN.slug`)
// or that token minus a single leading `word:` namespace prefix. Some upstream
// repos do the latter: their docs write `<!-- ns:NN.slug -->` but the ledger ID
// column stores `NN.slug`. Reduced mode joins on exact string equality first and
// falls back to a namespace-stripped lookup (see preSeedReduced).
//
// Parsing is fence- and heading-aware (like scanBodyTasks) and tolerant: a missing
// table, or an unusable row, yields no entry rather than throwing. Tolerant is not
// silent, though - a ledger that produces nothing useful says so via console.warn,
// because the failure it hides looks exactly like "this checklist has no ledger".
//
// Known limitations, both on shapes that are legal GFM but that no ledger writes:
// a row must START with a pipe to be seen at all, so a table written without leading
// pipes is invisible AND silent - the ledger reads as absent. And a row is split on
// its unescaped pipes (`\|` is a literal pipe, per GFM) but the escape handling stops
// there: a cell ending in an escaped backslash (`\\|`) still splits wrong. A missing
// TRAILING pipe is fine; only an empty edge cell is dropped.

import type { RunDoc } from './types';
import { flattenSteps } from './parse';
import { setStep, stepState, type RunState, type StepState } from './state';

const FENCE_RE = /^\s*(`{3,}|~{3,})/;
const HEADING_RE = /^#{1,6}\s+(.*?)\s*#*\s*$/;
const LEDGER_HEADING_RE = /^#{1,6}\s+Per-box ledger\b/i;

/** The ledger cell value that defers to the tag's default role. */
const ROLE_SENTINEL = '-';

/** Roles whose box is the tester's own click in every run, so no machine covers it. */
const TESTER_ROLES = new Set(['session', 'teardown']);

/** One ledger row's coverage facts, keyed elsewhere by the row's stable id. */
export interface LedgerEntry {
  /** Coverage tag, uppercased: CI SEED CHECK VISUAL BROWSER O365 OPERATOR. */
  tag: string;
  /** Resolved effective role, lowercased: build teardown session verify manual. */
  role: string;
}

/** Column indices read off the ledger's header row. `role` is -1 when absent. */
interface Cols {
  tag: number;
  id: number;
  role: number;
}

/** Strip a single pair of surrounding backticks and trim, so `` `qa:01.x` `` == `qa:01.x`. */
function cell(raw: string): string {
  return raw.trim().replace(/^`(.*)`$/, '$1').trim();
}

/**
 * The normalized inner cells of a `| a | b |` row. Only an EMPTY edge part is dropped,
 * so a row whose trailing pipe was left off keeps its last cell. Blindly dropping both
 * edges would not drop such a row - it would parse it one column short, and a missing
 * Role cell reads as the tag default, which over-skips a box the tester owes.
 */
function rowCells(line: string): string[] {
  const parts = splitRow(line).map(cell);
  if (parts.length > 0 && parts[0] === '') parts.shift();
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/**
 * Split a table row on its unescaped pipes. Per GFM, `\|` inside a row is a literal
 * pipe and does not delimit a cell, so splitting naively shifts every column to its
 * right - which, with header-driven indices, yields a confidently wrong tag and id
 * rather than a dropped row.
 */
function splitRow(line: string): string[] {
  const parts: string[] = [];
  let buf = '';
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\' && line[i + 1] === '|') {
      buf += '|';
      i++;
      continue;
    }
    if (line[i] === '|') {
      parts.push(buf);
      buf = '';
      continue;
    }
    buf += line[i];
  }
  parts.push(buf);
  return parts;
}

/** A markdown table separator row: every cell is dashes/colons only. */
function isSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c.trim()));
}

/**
 * Read column indices off a header row, or null when it is not one. A header must
 * name both Tag and ID; Role is optional. Names match by exact equality after
 * lowercasing, so a "Box (short lead label)" column can never pose as "ID".
 */
function headerColumns(cells: string[]): Cols | null {
  const idx = (name: string) => cells.findIndex((c) => c.toLowerCase() === name);
  const tag = idx('tag');
  const id = idx('id');
  if (tag < 0 || id < 0) return null;
  return { tag, id, role: idx('role') };
}

/** The cell at a header index; '' for a short row or an absent column. */
function at(cells: string[], i: number): string {
  return i >= 0 && i < cells.length ? cells[i] : '';
}

/**
 * Resolve a row's execution role: an empty or `-` cell (including an absent Role
 * column) takes the tag's default, which is `verify` for the machine-covered tags and
 * `manual` for everything else.
 */
function effectiveRole(tag: string, roleCell: string): string {
  const role = roleCell.trim().toLowerCase();
  if (role && role !== ROLE_SENTINEL) return role;
  return tag === 'CI' || tag === 'SEED' ? 'verify' : 'manual';
}

/**
 * Whether a machine already covers this box, matching what the external check-off job
 * pre-checks. SEED always; CI unless the row's role makes it the tester's own click.
 *
 * Two things here are easy to get wrong. A CI `build` row IS covered - the driver
 * performs that mutation - while its sibling `teardown` is not, because the tester
 * runs it herself after the manual block; the split is "who performs it", not "is it
 * a mutation". And there is deliberately no section gate: upstream suppresses the
 * doc badge in its operator sections, but the check-off job has no section awareness
 * and pre-checks those rows anyway. Badge is not skip.
 */
export function isMachineCovered(e: LedgerEntry): boolean {
  if (e.tag === 'SEED') return true;
  if (e.tag === 'CI') return !TESTER_ROLES.has(e.role);
  return false;
}

/**
 * Parse the "## Per-box ledger" table into a Map of stableId -> {tag, role}. Rows
 * outside the ledger section, the header and separator rows, and rows without both a
 * tag and an id are skipped. Returns an empty map when no ledger section or table is
 * present, warning to the console whenever a table was there but yielded nothing.
 */
export function parseCoverageLedger(markdown: string): Map<string, LedgerEntry> {
  const out = new Map<string, LedgerEntry>();
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  let inFence = false;
  let fenceRun = '';
  let active = false; // inside the "Per-box ledger" section
  let cols: Cols | null = null;
  let headerCandidates = 0; // |-rows seen while still looking for a header
  let dataRows = 0; // |-rows seen after the header

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
      // A second ledger heading brings its own table, so never inherit the first's columns.
      if (active) cols = null;
      continue;
    }
    if (!active) continue;

    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    const cells = rowCells(trimmed);
    if (isSeparatorRow(cells)) continue;

    if (!cols) {
      headerCandidates++;
      cols = headerColumns(cells);
      continue; // the header row is never data
    }

    // A row that reads as a header IS one: two tables concatenated under a single
    // heading get their own columns rather than the first table's, which would read
    // every following row through the wrong indices.
    const reheader = headerColumns(cells);
    if (reheader) {
      cols = reheader;
      continue;
    }

    dataRows++;
    const tag = at(cells, cols.tag).toUpperCase();
    const id = at(cells, cols.id);
    // A header-shaped row that names no Tag column falls through the re-read above,
    // so still refuse to key an entry on the literal word "id".
    if (!id || id.toLowerCase() === 'id') continue;
    if (!tag) continue;
    out.set(id, { tag, role: effectiveRole(tag, at(cells, cols.role)) });
  }

  warnAboutLedger(cols, headerCandidates, dataRows, out.size);
  return out;
}

/**
 * Say so when a ledger was present but produced nothing usable. Emitted once per
 * parse, from one place, so the scan above stays a pure loop. Silence when there was
 * genuinely no ledger to parse: that is a checklist without one, not a breakage.
 */
function warnAboutLedger(
  cols: Cols | null,
  headerCandidates: number,
  dataRows: number,
  parsed: number,
): void {
  if (!cols) {
    // `parsed > 0` means an earlier ledger section did produce entries and only a
    // later, table-less one left `cols` null. Nothing is broken, so say nothing.
    if (headerCandidates > 0 && parsed === 0) {
      console.warn(
        `[stamp] coverage: found ${headerCandidates} table row(s) under "Per-box ledger" but no ` +
          'header row naming both Tag and ID, so reduced mode will auto-skip nothing.',
      );
    }
    return;
  }
  if (cols.role < 0) {
    console.warn(
      '[stamp] coverage: the per-box ledger has no Role column, so every CI row counts as ' +
        'machine-covered and the sign-in and teardown steps that are the tester\'s own cannot ' +
        'be held back.',
    );
  }
  if (dataRows > 0 && parsed === 0) {
    console.warn(
      `[stamp] coverage: the per-box ledger header parsed but none of its ${dataRows} row(s) ` +
        'had both a Tag and an ID, so reduced mode will auto-skip nothing.',
    );
  }
}

/**
 * Pre-seed a run for reduced mode: every machine-covered box that is still `pending`
 * becomes an auto-skip carrying a provisional `auto:` note. Never overwrites an
 * existing status, so a tester verdict or an externally written check already
 * imported into the state survives.
 *
 * Returns the new state, the number of boxes auto-skipped, and the number of steps
 * whose id found a ledger row at all. The two counts differ for good reasons - a
 * ledger of purely manual work joins perfectly and skips nothing - so only `matched`
 * can tell a broken join from an honest one.
 */
export function preSeedReduced(
  doc: RunDoc,
  state: RunState,
  coverage: Map<string, LedgerEntry>,
): { state: RunState; count: number; matched: number } {
  let next = state;
  let count = 0;
  let matched = 0;
  for (const { step } of flattenSteps(doc)) {
    if (!step.stableId) continue;
    // Exact match wins; otherwise retry once with a single leading `word:`
    // namespace prefix stripped, since some repos store the token unprefixed in
    // the ledger ID column (comment `ns:NN.slug` -> ledger `NN.slug`).
    let entry = coverage.get(step.stableId);
    if (entry === undefined) {
      const stripped = step.stableId.replace(/^[A-Za-z0-9_-]+:/, '');
      if (stripped !== step.stableId) entry = coverage.get(stripped);
    }
    if (!entry) continue;
    matched++;
    if (!isMachineCovered(entry)) continue;
    if (stepState(next, step.id).status !== 'pending') continue; // never overwrite
    const seeded: StepState = { status: 'skip', note: `auto: machine-covered (${entry.tag})` };
    next = setStep(next, step.id, seeded);
    count++;
  }
  if (matched === 0 && coverage.size > 0) warnAboutJoin(doc, coverage);
  return { state: next, count, matched };
}

/**
 * A ledger that parsed cleanly and still matched nothing is almost always an id
 * mismatch between the ledger's ID column and the checklist's stable-id comments, so
 * name one of each: side by side, the shape of the mismatch is usually obvious.
 */
function warnAboutJoin(doc: RunDoc, coverage: Map<string, LedgerEntry>): void {
  const ledgerId = coverage.keys().next().value;
  const stepId = flattenSteps(doc).find((f) => f.step.stableId)?.step.stableId;
  console.warn(
    `[stamp] coverage: none of the ledger's ${coverage.size} id(s) matched a step in this ` +
      `checklist (ledger e.g. "${ledgerId}", step e.g. ` +
      `"${stepId ?? '(this checklist has no stable-id comments)'}").`,
  );
}
