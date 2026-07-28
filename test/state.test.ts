import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildRunDoc, flattenSteps } from '../src/lib/parse';
import {
  serializeIssueBody,
  parseIssueBody,
  applyStateToBody,
  countUnrepresentedSteps,
  canonicalDocUrl,
  parseMarker,
  hasStampMarker,
  setStep,
  stepState,
  isProvisional,
  reconcileResumeState,
  emptyState,
  summarize,
  screenshotReference,
  loadSettings,
  saveSettings,
  loadRunState,
  saveRunState,
  type RunState,
  type RunMeta,
} from '../src/lib/state';
import { createDebouncer } from '../src/lib/debounce';
import { source, dirFiles, idSource, idStepsV1, idStepsV2 } from './fixtures';

const doc = buildRunDoc(source, dirFiles);
const meta: RunMeta = {
  docUrl: 'https://github.com/acme/coffee-qa/tree/main/QA',
  sha: source.sha,
  path: 'QA',
  tool: 'stamp@0.1.0',
};

function stateWith(overrides: Record<number, { status: string; note?: string }>): RunState {
  const flat = flattenSteps(doc);
  let s = emptyState();
  for (const [idx, v] of Object.entries(overrides)) {
    s = setStep(s, flat[Number(idx)].step.id, v as { status: 'pass' | 'fail' | 'skip' | 'pending'; note?: string });
  }
  return s;
}

describe('metadata marker', () => {
  it('embeds parseable metadata incl. the tool version', () => {
    const body = serializeIssueBody(doc, emptyState(), meta);
    expect(hasStampMarker(body)).toBe(true);
    expect(parseMarker(body)).toEqual(meta);
  });

  it('resume matching does not depend on the version string', () => {
    // A body whose tool version differs still carries the stamp:v1 marker.
    const body = serializeIssueBody(doc, emptyState(), { ...meta, tool: 'stamp@9.9.9' });
    expect(hasStampMarker(body)).toBe(true);
    expect(parseMarker(body)?.tool).toBe('stamp@9.9.9');
  });
});

describe('serialize/parse round-trip', () => {
  it('round-trips pass / fail(with note) / skip / pending', () => {
    const s = stateWith({
      0: { status: 'pass' },
      1: { status: 'fail', note: 'crema was too thin' },
      2: { status: 'skip' },
      // step 3 left pending
    });
    const body = serializeIssueBody(doc, s, meta);
    const parsed = parseIssueBody(body, doc);
    expect(parsed).toEqual(s);
  });

  it('round-trips notes on pass, skip, and pending (note is a sibling of status)', () => {
    const s = stateWith({
      0: { status: 'pass', note: 'looked great' },
      1: { status: 'skip', note: 'no beans on hand' },
      2: { status: 'pending', note: 'come back to this' },
    });
    const body = serializeIssueBody(doc, s, meta);
    expect(parseIssueBody(body, doc)).toEqual(s);
  });

  it('flattens multi-line notes to a single round-trip-safe line', () => {
    const s = stateWith({ 0: { status: 'fail', note: 'line one\nline two\n  line three' } });
    const body = serializeIssueBody(doc, s, meta);
    expect(body).toContain('❌ FAIL: line one line two line three');
    const parsed = parseIssueBody(body, doc);
    const flat = flattenSteps(doc);
    expect(parsed.statuses[flat[0].step.id]).toEqual({ status: 'fail', note: 'line one line two line three' });
  });

  it('a fail with no note round-trips as a fail (empty note)', () => {
    const s = stateWith({ 1: { status: 'fail' } });
    const parsed = parseIssueBody(serializeIssueBody(doc, s, meta), doc);
    const flat = flattenSteps(doc);
    expect(parsed.statuses[flat[1].step.id].status).toBe('fail');
  });
});

describe('stable-id resume (orphan-bug regression)', () => {
  const idMeta: RunMeta = {
    docUrl: 'acme/coffee-qa/QA/steps.md',
    sha: idSource.sha,
    path: idSource.path,
    tool: 'stamp@0.1.0',
  };

  it('maps in-flight state by stable id after a step label is edited', () => {
    const v1 = buildRunDoc(idSource, [{ path: 'QA/steps.md', content: idStepsV1 }]);
    const v2 = buildRunDoc(idSource, [{ path: 'QA/steps.md', content: idStepsV2 }]);
    const flatV1 = flattenSteps(v1);
    const flatV2 = flattenSteps(v2);

    // Tester passes the first box on v1; the issue body records it.
    const s1 = setStep(emptyState(), flatV1[0].step.id, { status: 'pass' });
    const body = serializeIssueBody(v1, s1, idMeta);

    // The first box's bold lead (label) is reworded in v2 — same stable id.
    // Today's exact-label matcher would orphan the pass; the id matcher keeps it.
    const resumed = parseIssueBody(body, v2);
    expect(resumed.statuses[flatV2[0].step.id]?.status).toBe('pass');
  });

  it('serializes the stable-id comment onto id-bearing task lines only', () => {
    const d = buildRunDoc(idSource, [{ path: 'QA/steps.md', content: idStepsV1 }]);
    const body = serializeIssueBody(d, emptyState(), idMeta);
    // id-bearing boxes carry the comment verbatim...
    expect(body).toContain('- [ ] Power on. <!-- qa:01.power -->');
    expect(body).toContain('- [ ] Brew espresso. <!-- qa:02.brew -->');
    // ...the id-less third box does not (negative).
    expect(body).toContain('- [ ] Check crema.');
    expect(body).not.toMatch(/Check crema\..*<!--/);
  });

  it('round-trips a checked-with-comment task line back to state by id', () => {
    const d = buildRunDoc(idSource, [{ path: 'QA/steps.md', content: idStepsV1 }]);
    const flat = flattenSteps(d);
    const s = setStep(emptyState(), flat[0].step.id, { status: 'pass' });
    const parsed = parseIssueBody(serializeIssueBody(d, s, idMeta), d);
    expect(parsed.statuses[flat[0].step.id]).toEqual({ status: 'pass' });
  });

  it('duplicate stable ids fall back to label matching without cross-contaminating', () => {
    // Two boxes in one doc share an id (an authoring error the contract forbids,
    // but STAMP must degrade safely). The first box keeps the id anchor; the
    // second is disambiguated by its distinct label rather than colliding.
    const dup = buildRunDoc(source, [
      { path: 'QA/README.md', content: '# Dup Phase' },
      { path: 'QA/01-a.md', content: '# A\n- [ ] **Alpha.** box a <!-- qa:01.same -->' },
      { path: 'QA/02-b.md', content: '# B\n- [ ] **Beta.** box b <!-- qa:01.same -->' },
    ]);
    const flat = flattenSteps(dup);
    expect(flat).toHaveLength(2);
    const dupMeta: RunMeta = { ...meta, path: 'QA' };
    let s = emptyState();
    s = setStep(s, flat[0].step.id, { status: 'pass' });
    s = setStep(s, flat[1].step.id, { status: 'fail', note: 'boom' });
    const parsed = parseIssueBody(serializeIssueBody(dup, s, dupMeta), dup);
    expect(parsed.statuses[flat[0].step.id]?.status).toBe('pass');
    expect(parsed.statuses[flat[1].step.id]).toEqual({ status: 'fail', note: 'boom' });
  });

  it('leaves a body task line whose --> comment is malformed untouched (body-side guard)', () => {
    const flat = flattenSteps(doc);
    let body = serializeIssueBody(doc, emptyState(), meta);
    // Corrupt the first step's line with a token that swallowed the terminator.
    body = body.replace('- [ ] Power on.', '- [x] Power on. <!-- a-->b -->');
    const s = stateWith({ 0: { status: 'pass' } });
    const merged = applyStateToBody(body, doc, s);
    // The malformed token is not captured as an id, so it is not stripped off the
    // label; the retained comment makes the label differ from "Power on." and the
    // line stays foreign and preserved verbatim (never re-emitted to leak text).
    expect(merged).toContain('- [x] Power on. <!-- a-->b -->');
    expect(parseIssueBody(merged, doc).statuses[flat[0].step.id]).toBeUndefined();
  });

  it('an id-less doc serializes exactly as before (no comments emitted)', () => {
    const legacy = serializeIssueBody(doc, emptyState(), meta);
    expect(legacy).not.toContain('<!-- qa:');
    // still the plain task lines
    expect(legacy).toMatch(/- \[ \] Power on\.$/m);
  });

  it('resumes a pre-id issue body (no comments) and upgrades lines in place with the id', () => {
    const d = buildRunDoc(idSource, [{ path: 'QA/steps.md', content: idStepsV1 }]);
    const flat = flattenSteps(d);
    // An OLDER STAMP wrote this body before the doc gained ids: plain task lines,
    // no <!-- qa:... --> comments. Box 1 passed, box 2 failed with a note.
    const preIdBody = [
      formatMarkerLine(),
      '',
      '## Machine QA',
      '',
      '- [x] Power on.',
      '- [ ] Brew espresso.',
      '  - ❌ FAIL: no beans',
      '- [ ] Check crema.',
    ].join('\n');

    // Resume maps by exact label (ids absent on the body side), so state is read.
    const resumed = parseIssueBody(preIdBody, d);
    expect(resumed.statuses[flat[0].step.id]?.status).toBe('pass');
    expect(resumed.statuses[flat[1].step.id]).toEqual({ status: 'fail', note: 'no beans' });

    // The next PATCH upgrades the id-bearing lines in place with the comment,
    // with no duplication and no reordering.
    const merged = applyStateToBody(preIdBody, d, resumed);
    const taskLines = merged.split('\n').filter((l) => /^- \[/.test(l));
    expect(taskLines).toEqual([
      '- [x] Power on. <!-- qa:01.power -->',
      '- [x] Brew espresso. <!-- qa:02.brew -->',
      '- [ ] Check crema.',
    ]);
    // exactly one line per box (negative: no duplication)
    expect(merged.match(/Power on\./g)?.length).toBe(1);
    expect(merged.match(/Brew espresso\./g)?.length).toBe(1);
    expect(merged.match(/Check crema\./g)?.length).toBe(1);
    // the imported fail note is re-emitted (not dropped)
    expect(merged).toContain('❌ FAIL: no beans');
  });
});

describe('seed-qa coexistence (phase 2)', () => {
  const d = buildRunDoc(idSource, [{ path: 'QA/steps.md', content: idStepsV1 }]);
  const flat = flattenSteps(d);

  it('isProvisional flags pending and auto: pre-seeds, not real verdicts', () => {
    expect(isProvisional({ status: 'pending' })).toBe(true);
    expect(isProvisional({ status: 'skip', note: 'auto: machine-covered (CI)' })).toBe(true);
    expect(isProvisional({ status: 'skip' })).toBe(false);
    expect(isProvisional({ status: 'pass', note: 'looked good' })).toBe(false);
    expect(isProvisional({ status: 'fail', note: 'broke' })).toBe(false);
  });

  it("a tester's explicit verdict wins over the issue side", () => {
    const local: RunState = { statuses: { a: { status: 'fail', note: 'broke' } } };
    const issue: RunState = { statuses: { a: { status: 'pass', note: 'seeded by seed-qa @sha' } } };
    expect(reconcileResumeState(issue, local).statuses.a).toEqual({ status: 'fail', note: 'broke' });
  });

  it('an auto-skip is upgraded by an issue-side check on resume', () => {
    const local: RunState = { statuses: { a: { status: 'skip', note: 'auto: machine-covered (CI)' } } };
    const issue: RunState = { statuses: { a: { status: 'pass', note: 'qaassert green @sha' } } };
    expect(reconcileResumeState(issue, local).statuses.a).toEqual({ status: 'pass', note: 'qaassert green @sha' });
  });

  it('keeps a provisional auto-skip when the issue has nothing better', () => {
    const local: RunState = { statuses: { a: { status: 'skip', note: 'auto: machine-covered (SEED)' } } };
    const issue: RunState = { statuses: {} };
    expect(reconcileResumeState(issue, local).statuses.a).toEqual({ status: 'skip', note: 'auto: machine-covered (SEED)' });
  });

  it('adopts an issue status for a step absent from local state', () => {
    const local: RunState = { statuses: {} };
    const issue: RunState = { statuses: { a: { status: 'pass' } } };
    expect(reconcileResumeState(issue, local).statuses.a).toEqual({ status: 'pass' });
  });

  it('a seed-qa checked-with-note line survives import -> local edit -> PATCH', () => {
    // The issue as seed-qa leaves it: box 0 checked with a provenance note.
    const body = [
      '## Machine QA',
      '- [x] Power on. <!-- qa:01.power -->',
      '  - 📝 seeded by seed-qa @abc123',
      '- [ ] Brew espresso. <!-- qa:02.brew -->',
      '- [ ] Check crema.',
    ].join('\n');

    // Import: the note must land in local state, or the next PATCH would erase it.
    const imported = parseIssueBody(body, d);
    expect(imported.statuses[flat[0].step.id]).toEqual({ status: 'pass', note: 'seeded by seed-qa @abc123' });

    // The tester resolves a DIFFERENT box locally, then the debounced PATCH runs.
    const edited = setStep(imported, flat[2].step.id, { status: 'pass' });
    const merged = applyStateToBody(body, d, edited);

    // The seed-qa evidence is preserved verbatim, not clobbered.
    expect(merged).toContain('- [x] Power on. <!-- qa:01.power -->');
    expect(merged).toContain('📝 seeded by seed-qa @abc123');
    expect(merged).toMatch(/- \[x\] Check crema\./);

    // ...and re-parses cleanly, still carrying the note.
    const reparsed = parseIssueBody(merged, d);
    expect(reparsed.statuses[flat[0].step.id]).toEqual({ status: 'pass', note: 'seeded by seed-qa @abc123' });
  });

  it('a checked box keeps its pass over a stale auto-skip bullet (end-to-end body level)', () => {
    // A reduced run wrote box 0 as an auto-skip: unchecked with a `⏭ skipped`
    // bullet carrying the provisional note.
    const reduced = [
      '## Machine QA',
      '- [ ] Power on. <!-- qa:01.power -->',
      '  - ⏭ skipped - auto: machine-covered (CI)',
      '- [ ] Brew espresso. <!-- qa:02.brew -->',
      '- [ ] Check crema.',
    ].join('\n');

    // seed-qa runs: it flips the box to `- [x]` and appends a provenance note
    // AFTER the old skip bullet (exactly as the seed-qa spec does), without
    // removing the stale bullet.
    const afterSeedQa = [
      '## Machine QA',
      '- [x] Power on. <!-- qa:01.power -->',
      '  - ⏭ skipped - auto: machine-covered (CI)',
      '  - 📝 qaassert green @abc123',
      '- [ ] Brew espresso. <!-- qa:02.brew -->',
      '- [ ] Check crema.',
    ].join('\n');

    // The checked box imports as PASS with the qaassert note, NOT as a skip.
    const imported = parseIssueBody(afterSeedQa, d);
    expect(imported.statuses[flat[0].step.id]).toEqual({ status: 'pass', note: 'qaassert green @abc123' });

    // Reconcile against the local auto-skip: the issue evidence upgrades it.
    const local = parseIssueBody(reduced, d);
    expect(local.statuses[flat[0].step.id]).toEqual({ status: 'skip', note: 'auto: machine-covered (CI)' });
    const reconciled = reconcileResumeState(imported, local);
    expect(reconciled.statuses[flat[0].step.id]).toEqual({ status: 'pass', note: 'qaassert green @abc123' });

    // The next PATCH keeps the box checked with the note and drops the stale
    // skip bullet (no ping-pong un-check).
    const merged = applyStateToBody(afterSeedQa, d, reconciled);
    expect(merged).toContain('- [x] Power on. <!-- qa:01.power -->');
    expect(merged).toContain('📝 qaassert green @abc123');
    expect(merged).not.toContain('⏭ skipped');
    expect(parseIssueBody(merged, d).statuses[flat[0].step.id]).toEqual({
      status: 'pass',
      note: 'qaassert green @abc123',
    });
  });
});

describe('applyStateToBody (merge onto existing body)', () => {
  it('preserves foreign human-added lines and comments', () => {
    let body = serializeIssueBody(doc, emptyState(), meta);
    body = body.replace('## 1. Brewing [BLOCKING]', '## 1. Brewing [BLOCKING]\n\n> NOTE from Jason: skip the descale sub-step today.');
    const s = stateWith({ 0: { status: 'pass' } });
    const merged = applyStateToBody(body, doc, s);
    expect(merged).toContain('> NOTE from Jason: skip the descale sub-step today.');
    // and the first step is now checked
    expect(merged).toMatch(/- \[x\] Power on\./);
  });

  it('leaves a hand-renamed label untouched (label-anchored: it is now foreign)', () => {
    let body = serializeIssueBody(doc, emptyState(), meta);
    body = body.replace('- [ ] Power on.', '- [ ] Power on (renamed by hand)');
    const s = stateWith({ 0: { status: 'pass' } });
    const merged = applyStateToBody(body, doc, s);
    // The renamed line no longer matches the doc label, so it is preserved
    // verbatim rather than being clobbered by a shifted position.
    expect(merged).toContain('- [ ] Power on (renamed by hand)');
    expect(merged).not.toContain('- [x] Power on (renamed by hand)');
  });

  it('maps by label even when a foreign task line is inserted above (M3)', () => {
    let body = serializeIssueBody(doc, emptyState(), meta);
    // A human inserts their own checkbox before the first real step.
    body = body.replace('- [ ] Power on.', '- [ ] my own side task\n- [ ] Power on.');
    const s = stateWith({ 0: { status: 'pass' } });
    const merged = applyStateToBody(body, doc, s);
    // Positional merge would have checked the foreign line; label matching checks
    // the real step and leaves the foreign line pending.
    expect(merged).toContain('- [ ] my own side task');
    expect(merged).toMatch(/- \[x\] Power on\./);
  });

  it('does not treat a fenced `- [ ] in the body as a task line (M3)', () => {
    let body = serializeIssueBody(doc, emptyState(), meta);
    body = body.replace(
      '## 1. Brewing [BLOCKING]',
      '## 1. Brewing [BLOCKING]\n\n```\n- [x] fenced example, not a real step\n```',
    );
    const s = stateWith({ 0: { status: 'pass' } });
    const merged = applyStateToBody(body, doc, s);
    // The fenced checkbox is preserved as-is and never consumed as step 0.
    expect(merged).toContain('- [x] fenced example, not a real step');
    expect(merged).toMatch(/- \[x\] Power on\./);
    // round-trips: the fenced line does not become tracked state
    const flat = flattenSteps(doc);
    const parsed = parseIssueBody(merged, doc);
    expect(parsed.statuses[flat[0].step.id]?.status).toBe('pass');
  });

  it('disambiguates duplicate labels by ordinal, positional as tiebreak (M3)', () => {
    const dupDoc = buildRunDoc(source, [
      { path: 'QA/dup.md', content: '# Dup\n- [ ] same\n- [ ] same' },
    ]);
    const dupFlat = flattenSteps(dupDoc);
    const dupMeta: RunMeta = { ...meta, path: 'QA/dup.md' };
    let s = emptyState();
    s = setStep(s, dupFlat[0].step.id, { status: 'pass' });
    s = setStep(s, dupFlat[1].step.id, { status: 'fail', note: 'second one broke' });
    const body = serializeIssueBody(dupDoc, s, dupMeta);
    const parsed = parseIssueBody(body, dupDoc);
    expect(parsed.statuses[dupFlat[0].step.id]?.status).toBe('pass');
    expect(parsed.statuses[dupFlat[1].step.id]).toEqual({ status: 'fail', note: 'second one broke' });
  });

  it('does not accumulate duplicate note bullets across repeated merges', () => {
    let body = serializeIssueBody(doc, emptyState(), meta);
    const s = stateWith({ 1: { status: 'fail', note: 'thin crema' } });
    body = applyStateToBody(body, doc, s);
    body = applyStateToBody(body, doc, s);
    body = applyStateToBody(body, doc, s);
    expect(body.match(/❌ FAIL: thin crema/g)?.length).toBe(1);
  });

  it('resume tolerates unknown/renamed lines without crashing', () => {
    const weird = [
      'random human preamble',
      '- [x] totally different label here',
      '  - not one of our note bullets',
      '## some heading a person added',
      '- [ ] another line',
    ].join('\n');
    expect(() => parseIssueBody(weird, doc)).not.toThrow();
    // label-anchored: none of these lines match a doc label, so nothing is
    // mapped (negative assertion — foreign lines do NOT become step state).
    const flat = flattenSteps(doc);
    const parsed = parseIssueBody(weird, doc);
    expect(parsed.statuses[flat[0].step.id]).toBeUndefined();
    expect(Object.keys(parsed.statuses)).toHaveLength(0);
  });
});

describe('CRLF issue bodies (H1)', () => {
  it('applyStateToBody updates a CRLF body instead of silently no-oping', () => {
    const lf = serializeIssueBody(doc, emptyState(), meta);
    const crlf = lf.replace(/\n/g, '\r\n');
    const s = stateWith({ 0: { status: 'pass' } });
    const merged = applyStateToBody(crlf, doc, s);
    expect(merged).toMatch(/- \[x\] Power on\./);
  });

  it('parseIssueBody reads state out of a CRLF body (round-trip)', () => {
    const s = stateWith({
      0: { status: 'pass' },
      1: { status: 'fail', note: 'thin crema' },
      2: { status: 'skip' },
    });
    const crlf = serializeIssueBody(doc, s, meta).replace(/\n/g, '\r\n');
    expect(parseIssueBody(crlf, doc)).toEqual(s);
  });

  it('serialize -> CRLF -> apply -> parse round-trips cleanly', () => {
    const s = stateWith({ 0: { status: 'fail', note: 'boom' }, 3: { status: 'skip' } });
    let body = serializeIssueBody(doc, emptyState(), meta).replace(/\n/g, '\r\n');
    body = applyStateToBody(body, doc, s);
    expect(parseIssueBody(body, doc)).toEqual(s);
  });
});

describe('tolerant skip-note parsing (L7)', () => {
  it('parses a skip note written with a plain hyphen, not an em dash', () => {
    const flat = flattenSteps(doc);
    const body = [
      formatMarkerLine(),
      '## 1. Brewing [BLOCKING]',
      '- [ ] Power on.',
      '  - ⏭ skipped - no power today',
    ].join('\n');
    const parsed = parseIssueBody(body, doc);
    expect(parsed.statuses[flat[0].step.id]).toEqual({ status: 'skip', note: 'no power today' });
  });
});

describe('countUnrepresentedSteps (M3 notice)', () => {
  it('is zero for a freshly serialized body', () => {
    const body = serializeIssueBody(doc, emptyState(), meta);
    expect(countUnrepresentedSteps(body, doc)).toBe(0);
  });

  it('counts steps whose task line a human deleted from the body', () => {
    let body = serializeIssueBody(doc, emptyState(), meta);
    // Remove the "Power on." step line entirely.
    body = body
      .split('\n')
      .filter((l) => !l.includes('Power on.'))
      .join('\n');
    expect(countUnrepresentedSteps(body, doc)).toBe(1);
  });
});

describe('canonicalDocUrl (L4)', () => {
  it('collapses a tree URL and a bare owner/repo/path to the same identity', () => {
    const a = canonicalDocUrl({ owner: 'Acme', repo: 'Coffee-QA', path: 'QA' });
    const b = canonicalDocUrl({ owner: 'acme', repo: 'coffee-qa', path: '/QA/' });
    expect(a).toBe(b);
    expect(a).toBe('acme/coffee-qa/QA');
  });

  it('distinguishes different paths (negative)', () => {
    expect(canonicalDocUrl({ owner: 'a', repo: 'b', path: 'QA' })).not.toBe(
      canonicalDocUrl({ owner: 'a', repo: 'b', path: 'QB' }),
    );
  });

  it('handles the repo root (empty path)', () => {
    expect(canonicalDocUrl({ owner: 'a', repo: 'b', path: '' })).toBe('a/b');
  });
});

function formatMarkerLine(): string {
  return `<!-- stamp:v1 {"docUrl":"acme/coffee-qa/QA","sha":"${source.sha}","path":"QA","tool":"stamp@0.1.0"} -->`;
}

describe('summarize', () => {
  it('counts per-phase totals and flags blocking failures', () => {
    const s = stateWith({ 0: { status: 'pass' }, 1: { status: 'fail' } });
    const sum = summarize(doc, s);
    expect(sum.totals.pass).toBe(1);
    expect(sum.totals.fail).toBe(1);
    // step 1 is in phase 1 "Brewing" which is BLOCKING
    expect(sum.blockingFailures).toBe(1);
    const brewing = sum.phases.find((p) => p.title.includes('Brewing'))!;
    expect(brewing.blocking).toBe(true);
  });
});

describe('screenshotReference', () => {
  it('formats a paste-ready reference line', () => {
    const flat = flattenSteps(doc);
    expect(screenshotReference('1. Brewing', flat[0].step)).toBe('Screenshot for: 1. Brewing / Power on.');
  });
});

describe('setStep transitions', () => {
  const id = flattenSteps(doc)[0].step.id;

  it('starts pending and transitions through statuses', () => {
    let s = emptyState();
    expect(stepState(s, id).status).toBe('pending');
    s = setStep(s, id, { status: 'pass' });
    expect(stepState(s, id).status).toBe('pass');
    s = setStep(s, id, { status: 'fail' });
    expect(stepState(s, id).status).toBe('fail');
  });

  it('keeps a note when status changes (note is a sibling of status)', () => {
    let s = setStep(emptyState(), id, { note: 'jotting before deciding' });
    expect(stepState(s, id)).toEqual({ status: 'pending', note: 'jotting before deciding' });
    s = setStep(s, id, { status: 'pass' });
    expect(stepState(s, id)).toEqual({ status: 'pass', note: 'jotting before deciding' });
  });

  it('drops back to default (no stored entry) when reset to pending with no note', () => {
    let s = setStep(emptyState(), id, { status: 'pass' });
    s = setStep(s, id, { status: 'pending', note: '' });
    expect(s.statuses[id]).toBeUndefined();
  });

  it('does not mutate the previous state object', () => {
    const s0 = emptyState();
    const s1 = setStep(s0, id, { status: 'pass' });
    expect(s0.statuses).toEqual({});
    expect(s1).not.toBe(s0);
  });
});

describe('localStorage persistence', () => {
  beforeEach(() => localStorage.clear());

  it('round-trips settings', () => {
    expect(loadSettings()).toBeUndefined();
    saveSettings({ githubUrl: 'acme/coffee-qa', token: 't', appHost: 'machine.local' });
    expect(loadSettings()).toEqual({ githubUrl: 'acme/coffee-qa', token: 't', appHost: 'machine.local' });
  });

  it('round-trips run state under its composite key', () => {
    const s = setStep(emptyState(), 'x#1-aaaa', { status: 'pass' });
    saveRunState('url', 'sha1', 7, s);
    expect(loadRunState('url', 'sha1', 7)).toEqual(s);
    // a different issue number is a different slot
    expect(loadRunState('url', 'sha1', 8)).toEqual(emptyState());
  });

  it('falls back cleanly on corrupt/truncated stored JSON', () => {
    localStorage.setItem('stamp:settings', '{ not valid json');
    expect(loadSettings()).toBeUndefined();
    localStorage.setItem('stamp:run:url#sha1#local', '{"statuses": {trunc');
    expect(loadRunState('url', 'sha1', null)).toEqual(emptyState());
  });
});

describe('createDebouncer (fake timers)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fires once after the quiet period, coalescing rapid schedules', () => {
    const fn = vi.fn();
    const d = createDebouncer(fn, 3000);
    d.schedule();
    d.schedule();
    d.schedule();
    expect(fn).not.toHaveBeenCalled();
    expect(d.pending()).toBe(true);
    vi.advanceTimersByTime(3000);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(d.pending()).toBe(false);
  });

  it('flush() runs immediately when pending and is a no-op otherwise', () => {
    const fn = vi.fn();
    const d = createDebouncer(fn, 3000);
    d.flush();
    expect(fn).not.toHaveBeenCalled();
    d.schedule();
    d.flush();
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('cancel() prevents a pending fire', () => {
    const fn = vi.fn();
    const d = createDebouncer(fn, 3000);
    d.schedule();
    d.cancel();
    vi.advanceTimersByTime(5000);
    expect(fn).not.toHaveBeenCalled();
  });
});
