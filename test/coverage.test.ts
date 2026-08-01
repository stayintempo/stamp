import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  parseCoverageLedger,
  preSeedReduced,
  isMachineCovered,
  type LedgerEntry,
} from '../src/lib/coverage';
import { buildRunDoc, flattenSteps } from '../src/lib/parse';
import { emptyState, setStep } from '../src/lib/state';
import { idSource, idStepsV1 } from './fixtures';

/** Swallow the lib's diagnostics so a warn-asserting test never dirties the output. */
function spyWarn() {
  return vi.spyOn(console, 'warn').mockImplementation(() => {});
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** A ledger entry, spelled out so the role under test is never implied. */
function entry(tag: string, role: string): LedgerEntry {
  return { tag, role };
}

const LEDGER = `# Coverage

Intro prose that is not a table.

## Per-box ledger

| Sec | # | Box (short lead label) | Tag | Owner | ID | Role |
| --- | --- | --- | --- | --- | --- | --- |
| 01 | 1 | Power on | CI | dev | qa:01.power | - |
| 01 | 2 | Brew espresso | SEED | dev | qa:02.brew | - |
| 02 | 1 | Check crema | CHECK | qa | qa:03.crema | - |
| 03 | 1 | Backticked cells | \`ci\` | dev | \`qa:04.tick\` | \`Session\` |
| 04 | 1 | Sign in as the tester | CI | dev | qa:05.signin | session |
| 04 | 2 | Retire the scratch machine | CI | dev | qa:06.teardown | teardown |
| 04 | 3 | Create the scratch machine | CI | dev | qa:07.build | build |
| 04 | 4 | Self-contained assertion | CI | dev | qa:08.verify | verify |
| 05 | 1 | A future appended column | CHECK | qa | qa:09.wide | - | extra |
| 05 | 2 | Missing the id cell | CHECK |
| 05 | 3 | Grind \\| tamp | CI | dev | qa:10.escaped | session |

## Some other section

| z | z | z | CI | z | qa:99.ignored | - |
`;

describe('parseCoverageLedger', () => {
  const map = parseCoverageLedger(LEDGER);

  it('maps each ledger row from stable id to its tag and effective role', () => {
    expect(map.get('qa:01.power')).toEqual(entry('CI', 'verify'));
    expect(map.get('qa:02.brew')).toEqual(entry('SEED', 'verify'));
    expect(map.get('qa:03.crema')).toEqual(entry('CHECK', 'manual'));
  });

  it('resolves the - role sentinel to the tag default', () => {
    // CI and SEED default to verify; every other tag defaults to manual.
    expect(map.get('qa:01.power')?.role).toBe('verify');
    expect(map.get('qa:02.brew')?.role).toBe('verify');
    expect(map.get('qa:03.crema')?.role).toBe('manual');
  });

  it('keeps an explicit role verbatim', () => {
    expect(map.get('qa:05.signin')?.role).toBe('session');
    expect(map.get('qa:06.teardown')?.role).toBe('teardown');
    expect(map.get('qa:07.build')?.role).toBe('build');
    expect(map.get('qa:08.verify')?.role).toBe('verify');
  });

  it('normalizes backticked cells, uppercasing the tag and lowercasing the role', () => {
    expect(map.get('qa:04.tick')).toEqual(entry('CI', 'session'));
  });

  it('ignores extra columns a future ledger appends', () => {
    // The #34 regression: a fixed six-column width check dropped every row of the
    // seven-column ledger, so reduced mode silently skipped nothing.
    expect(map.get('qa:09.wide')).toEqual(entry('CHECK', 'manual'));
  });

  it('skips a row missing its ID cell (negative)', () => {
    // 10 usable rows; the short CHECK row contributes nothing.
    expect(map.size).toBe(10);
  });

  it('ignores tables outside the ledger section (heading-aware, negative)', () => {
    expect(map.has('qa:99.ignored')).toBe(false);
  });

  it('finds columns by header name regardless of column order', () => {
    const md = [
      '## Per-box ledger',
      '',
      '| ID | Role | Tag | Sec |',
      '| --- | --- | --- | --- |',
      '| qa:01.power | session | CI | 01 |',
    ].join('\n');
    expect(parseCoverageLedger(md).get('qa:01.power')).toEqual(entry('CI', 'session'));
  });

  it('parses a six-column ledger with no Role column, defaulting the role', () => {
    // The pre-Role shape. Still supported, but warned about: a MISSING Role column
    // and a RENAMED one are indistinguishable here, and the latter silently
    // over-skips the tester's own steps.
    const warn = spyWarn();
    const md = [
      '## Per-box ledger',
      '',
      '| Sec | # | Box | Tag | Owner | ID |',
      '| --- | --- | --- | --- | --- | --- |',
      '| 01 | 1 | Power on | CI | dev | qa:01.power |',
      '| 02 | 1 | Check crema | CHECK | qa | qa:03.crema |',
    ].join('\n');
    const m = parseCoverageLedger(md);
    expect(m.get('qa:01.power')).toEqual(entry('CI', 'verify'));
    expect(m.get('qa:03.crema')).toEqual(entry('CHECK', 'manual'));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/no Role column/);
  });

  it('returns an empty map when there is no ledger section', () => {
    expect(parseCoverageLedger('# Doc\n\nNo ledger here.\n').size).toBe(0);
  });

  it('returns an empty map when the ledger heading has no table', () => {
    expect(parseCoverageLedger('## Per-box ledger\n\nComing soon.\n').size).toBe(0);
  });

  it('does not warn when the document has no ledger to parse (negative)', () => {
    // No ledger is a checklist without one, not a breakage. Staying quiet here is
    // what makes the warnings below worth reading.
    const warn = spyWarn();
    parseCoverageLedger('# Doc\n\nNo ledger here.\n');
    parseCoverageLedger('## Per-box ledger\n\nComing soon.\n');
    expect(warn).not.toHaveBeenCalled();
  });

  it('treats a table with no Tag/ID header as unusable and warns (negative)', () => {
    const warn = spyWarn();
    const md = ['## Per-box ledger', '', '| a | b |', '| --- | --- |', '| 01 | CI |'].join('\n');
    expect(parseCoverageLedger(md).size).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/no header row naming both Tag and ID/);
  });

  it('warns when the header parsed but no row carried both a tag and an id', () => {
    const warn = spyWarn();
    const md = [
      '## Per-box ledger',
      '',
      '| Sec | Tag | ID | Role |',
      '| --- | --- | --- | --- |',
      '| 01 | CI |  | - |',
      '| 02 |  | qa:02.brew | - |',
    ].join('\n');
    expect(parseCoverageLedger(md).size).toBe(0);
    expect(warn.mock.calls.map((c) => c[0]).join('\n')).toMatch(/none of its 2 row\(s\)/);
  });

  it('keeps the last cell of a row whose trailing pipe was left off', () => {
    // GitHub renders this identically to the fully piped row, so the slip is easy to
    // make and impossible to see. Dropping both edge parts unconditionally would eat
    // the Role cell and silently default the role.
    const md = [
      '## Per-box ledger',
      '',
      '| Sec | Tag | ID | Role |',
      '| --- | --- | --- | --- |',
      '| 01 | CI | qa:01.teardown | teardown',
      '| 02 | CI | qa:02.blank |  |',
    ].join('\n');
    const m = parseCoverageLedger(md);
    expect(m.get('qa:01.teardown')).toEqual(entry('CI', 'teardown'));
    // Negative: the role must NOT have defaulted, or the tester's own step is skipped.
    expect(isMachineCovered(m.get('qa:01.teardown')!)).toBe(false);
    // A genuinely empty trailing cell is still an empty cell, not a missing one.
    expect(m.get('qa:02.blank')).toEqual(entry('CI', 'verify'));
  });

  it('finds the Role column on a header row whose trailing pipe was left off', () => {
    const warn = spyWarn();
    const md = [
      '## Per-box ledger',
      '',
      '| Sec | Tag | ID | Role',
      '| --- | --- | --- | ---',
      '| 01 | CI | qa:01.signin | session |',
    ].join('\n');
    expect(parseCoverageLedger(md).get('qa:01.signin')).toEqual(entry('CI', 'session'));
    // Negative: losing the header's last cell would have raised the no-Role warning.
    expect(warn).not.toHaveBeenCalled();
  });

  it('re-reads the columns when a second header row reorders them', () => {
    // Two tables concatenated under one heading. Reading the second table's rows
    // through the first table's indices would key entries on the wrong cells.
    const md = [
      '## Per-box ledger',
      '',
      '| Tag | ID | Role |',
      '| --- | --- | --- |',
      '| CI | qa:01.power | - |',
      '',
      '| ID | Tag | Role |',
      '| --- | --- | --- |',
      '| qa:02.brew | SEED | - |',
    ].join('\n');
    const m = parseCoverageLedger(md);
    expect(m.get('qa:01.power')).toEqual(entry('CI', 'verify'));
    expect(m.get('qa:02.brew')).toEqual(entry('SEED', 'verify'));
    // Negative: no entry keyed on a header cell that was read as data.
    expect(m.size).toBe(2);
  });

  it('does not claim a missing header when an earlier ledger section parsed (negative)', () => {
    const warn = spyWarn();
    const md = [
      '## Per-box ledger',
      '',
      '| Tag | ID | Role |',
      '| --- | --- | --- |',
      '| CI | qa:01.power | - |',
      '',
      '## Per-box ledger (draft)',
      '',
      '| still | being | written |',
    ].join('\n');
    expect(parseCoverageLedger(md).get('qa:01.power')).toEqual(entry('CI', 'verify'));
    expect(warn).not.toHaveBeenCalled();
  });

  it('ignores a table nested in a fenced code block within the section', () => {
    const md = [
      '## Per-box ledger',
      '',
      '```',
      '| Sec | # | Box | Tag | Owner | ID | Role |',
      '| 01 | 1 | Fenced | CI | dev | qa:01.fenced | - |',
      '```',
      '',
      '| Sec | # | Box | Tag | Owner | ID | Role |',
      '| --- | --- | --- | --- | --- | --- | --- |',
      '| 01 | 2 | Real | SEED | dev | qa:01.real | - |',
    ].join('\n');
    const m = parseCoverageLedger(md);
    expect(m.has('qa:01.fenced')).toBe(false);
    expect(m.get('qa:01.real')).toEqual(entry('SEED', 'verify'));
  });

  it('does not inherit the first table columns at a second ledger heading', () => {
    // Two ledger sections with different column orders: the second must read its own
    // header, not the first's indices.
    const md = [
      '## Per-box ledger',
      '',
      '| Sec | Tag | ID | Role |',
      '| --- | --- | --- | --- |',
      '| 01 | CI | qa:01.power | - |',
      '',
      '## Per-box ledger',
      '',
      '| ID | Tag | Role |',
      '| --- | --- | --- |',
      '| qa:02.brew | SEED | - |',
    ].join('\n');
    const m = parseCoverageLedger(md);
    expect(m.get('qa:01.power')).toEqual(entry('CI', 'verify'));
    expect(m.get('qa:02.brew')).toEqual(entry('SEED', 'verify'));
  });
});

describe('escaped pipes in a ledger row', () => {
  it('keeps an escaped pipe inside its cell instead of splitting the row', () => {
    // GFM: `\|` is a literal pipe, not a delimiter. Splitting naively would shift
    // every column right of the label.
    expect(parseCoverageLedger(LEDGER).get('qa:10.escaped')).toEqual(entry('CI', 'session'));
  });

  it('does not shift the columns right of an escaped pipe (negative)', () => {
    // The real failure mode is a confidently WRONG row, not a dropped one: a naive
    // split reads Owner as the tag and the label's tail as the id. Assert the
    // neighbours, not just the row's presence.
    const md = [
      '## Per-box ledger',
      '',
      '| Sec | # | Box | Tag | Owner | ID | Role |',
      '| --- | --- | --- | --- | --- | --- | --- |',
      '| 05 | 3 | Grind \\| tamp | CI | dev | qa:10.escaped | build |',
    ].join('\n');
    const m = parseCoverageLedger(md);
    expect(m.get('qa:10.escaped')).toEqual(entry('CI', 'build'));
    expect(m.has('dev')).toBe(false);
    expect(m.has('tamp')).toBe(false);
    expect(m.size).toBe(1);
  });

  it('leaves a row with no escapes unchanged', () => {
    const m = parseCoverageLedger(LEDGER);
    expect(m.get('qa:01.power')).toEqual(entry('CI', 'verify'));
    expect(m.get('qa:03.crema')).toEqual(entry('CHECK', 'manual'));
  });
});

describe('isMachineCovered', () => {
  // Mirrors the external check-off job: SEED always; CI unless the row's role makes
  // the step the tester's own click. There is deliberately no section gate.
  const cases: Array<[string, string, boolean]> = [
    ['SEED', 'verify', true],
    ['SEED', 'manual', true],
    ['CI', 'verify', true],
    ['CI', 'build', true], // the driver performs the build mutation
    ['CI', 'manual', true],
    ['CI', 'session', false], // a sign-in nobody but the tester can perform
    ['CI', 'teardown', false], // deferred until after her manual block
    ['CHECK', 'manual', false],
    ['O365', 'manual', false],
    ['OPERATOR', 'manual', false],
    ['VISUAL', 'manual', false],
    ['BROWSER', 'manual', false],
    ['NEW', 'manual', false], // an unknown tag is never assumed covered
  ];

  for (const [tag, role, want] of cases) {
    it(`${want ? 'covers' : 'does not cover'} ${tag}/${role}${want ? '' : ' (negative)'}`, () => {
      expect(isMachineCovered(entry(tag, role))).toBe(want);
    });
  }
});

describe('preSeedReduced', () => {
  // idStepsV1 boxes: qa:01.power, qa:02.brew, and a third with no id.
  const doc = buildRunDoc(idSource, [{ path: 'QA/steps.md', content: idStepsV1 }]);
  const flat = flattenSteps(doc);

  it('auto-skips only machine-covered boxes, tagging the note with the provenance', () => {
    // qa:01.power = CI (covered), qa:02.brew = CHECK (not covered).
    const cov = new Map([
      ['qa:01.power', entry('CI', 'verify')],
      ['qa:02.brew', entry('CHECK', 'manual')],
    ]);
    const { state, count } = preSeedReduced(doc, emptyState(), cov);
    expect(count).toBe(1);
    expect(state.statuses[flat[0].step.id]).toEqual({ status: 'skip', note: 'auto: machine-covered (CI)' });
    // CHECK box and the id-less third box are untouched (negative).
    expect(state.statuses[flat[1].step.id]).toBeUndefined();
    expect(state.statuses[flat[2].step.id]).toBeUndefined();
  });

  it('does not auto-skip a CI box whose role is session (negative)', () => {
    // The driver's session lives in its own cookie jar, so the sign-in is hers in
    // every run. Pre-skipping it would claim a pass no machine made.
    const warn = spyWarn();
    const cov = new Map([['qa:01.power', entry('CI', 'session')]]);
    const { state, count, matched } = preSeedReduced(doc, emptyState(), cov);
    expect(count).toBe(0);
    expect(state).toEqual(emptyState());
    // The id DID join; skipping nothing is the correct answer, not a broken ledger.
    expect(matched).toBe(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not auto-skip a CI box whose role is teardown (negative)', () => {
    const cov = new Map([['qa:01.power', entry('CI', 'teardown')]]);
    const { state, count, matched } = preSeedReduced(doc, emptyState(), cov);
    expect(count).toBe(0);
    expect(state).toEqual(emptyState());
    expect(matched).toBe(1);
  });

  it('counts a match it did not skip, and stays quiet about it (negative)', () => {
    // A ledger of purely manual work joins perfectly and skips nothing. Warning here
    // would accuse a healthy ledger, and the message would name the same id as both
    // its "ledger e.g." and its "step e.g." example.
    const warn = spyWarn();
    const cov = new Map([
      ['qa:01.power', entry('CHECK', 'manual')],
      ['qa:02.brew', entry('O365', 'manual')],
    ]);
    const { state, count, matched } = preSeedReduced(doc, emptyState(), cov);
    expect(count).toBe(0);
    expect(matched).toBe(2);
    expect(state).toEqual(emptyState());
    expect(warn).not.toHaveBeenCalled();
  });

  it('auto-skips a CI build box, which the driver performs', () => {
    const cov = new Map([['qa:01.power', entry('CI', 'build')]]);
    const { state, count } = preSeedReduced(doc, emptyState(), cov);
    expect(count).toBe(1);
    expect(state.statuses[flat[0].step.id]).toEqual({ status: 'skip', note: 'auto: machine-covered (CI)' });
  });

  it('auto-skips a CI box carrying an explicit verify role', () => {
    // Explicit verify is legal but inert: identical in effect to the tag default.
    const cov = new Map([['qa:01.power', entry('CI', 'verify')]]);
    expect(preSeedReduced(doc, emptyState(), cov).count).toBe(1);
  });

  it('never overwrites a step that already has a status', () => {
    const seeded0 = setStep(emptyState(), flat[0].step.id, { status: 'pass' });
    const cov = new Map([
      ['qa:01.power', entry('CI', 'verify')],
      ['qa:02.brew', entry('SEED', 'verify')],
    ]);
    const { state, count } = preSeedReduced(doc, seeded0, cov);
    // box 0 already passed -> left alone; box 1 (SEED, pending) -> auto-skipped.
    expect(state.statuses[flat[0].step.id]).toEqual({ status: 'pass' });
    expect(state.statuses[flat[1].step.id]).toEqual({ status: 'skip', note: 'auto: machine-covered (SEED)' });
    expect(count).toBe(1);
  });

  it('an empty coverage map is a no-op', () => {
    const warn = spyWarn();
    const { state, count } = preSeedReduced(doc, emptyState(), new Map());
    expect(count).toBe(0);
    expect(state).toEqual(emptyState());
    // Nothing to join against is not a join failure (negative).
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns when the ledger has entries but none matched a step id (negative)', () => {
    const warn = spyWarn();
    const cov = new Map([['zz:99.nope', entry('CI', 'verify')]]);
    const { state, count } = preSeedReduced(doc, emptyState(), cov);
    expect(count).toBe(0);
    expect(state).toEqual(emptyState());
    expect(warn).toHaveBeenCalledTimes(1);
    // Both example ids are named, which is what makes the mismatch diagnosable.
    expect(warn.mock.calls[0][0]).toMatch(/none of the ledger's 1 id\(s\) matched/);
    expect(warn.mock.calls[0][0]).toMatch(/zz:99\.nope/);
    expect(warn.mock.calls[0][0]).toMatch(/qa:01\.power/);
  });

  it('pre-seeds a step whose ledger ID drops the doc comment namespace prefix', () => {
    // A common shape: the doc comment carries a namespace prefix (`ns:NN.slug`)
    // but COVERAGE.md's ID column stores it unprefixed, so an exact join misses
    // and we must fall back.
    const src = { owner: 'acme', repo: 'webapp', ref: 'main', sha: 'tsha00002222', path: 'QA/steps.md' };
    const steps = '# Acme QA\n\n- [ ] 🤖 auto **Reset and seed.** Wipe the dev DB. <!-- ns:00.reset-db -->\n';
    const d = buildRunDoc(src, [{ path: 'QA/steps.md', content: steps }]);
    const f = flattenSteps(d);
    const cov = new Map([['00.reset-db', entry('CI', 'verify')]]);
    const { state, count } = preSeedReduced(d, emptyState(), cov);
    expect(count).toBe(1);
    expect(state.statuses[f[0].step.id]).toEqual({ status: 'skip', note: 'auto: machine-covered (CI)' });
  });

  it('prefers an exact ledger ID over a namespace-stripped match when both exist', () => {
    // step stableId is `qa:01.power`. Give the exact key and the stripped key
    // different tags: only CI is machine-covered, so the exact hit must be used.
    const cov = new Map([
      ['qa:01.power', entry('CI', 'verify')],
      ['01.power', entry('CHECK', 'manual')],
    ]);
    const { state, count } = preSeedReduced(doc, emptyState(), cov);
    expect(count).toBe(1);
    expect(state.statuses[flat[0].step.id]).toEqual({ status: 'skip', note: 'auto: machine-covered (CI)' });
  });

  it('does no second lookup for a colon-less stableId, and never crosses namespaces (negative)', () => {
    // A colon-less stableId cannot strip anything, so a non-matching ledger row
    // seeds nothing. And `qa:x` must not reach a `qb:x` ledger entry: stripping
    // yields `x`, which is absent, so no box is covered.
    spyWarn(); // this deliberately trips the join warning
    const src = { owner: 'acme', repo: 'q', ref: 'main', sha: 'nsha00003333', path: 'QA/steps.md' };
    const steps = [
      '# Negative QA',
      '',
      '- [ ] 🤖 auto **No namespace.** No colon in this id. <!-- nocolon -->',
      '- [ ] 🤖 auto **Wrong namespace.** Colon but wrong prefix. <!-- qa:x -->',
      '',
    ].join('\n');
    const d = buildRunDoc(src, [{ path: 'QA/steps.md', content: steps }]);
    const cov = new Map([['other', entry('CI', 'verify')], ['qb:x', entry('CI', 'verify')]]);
    const { state, count } = preSeedReduced(d, emptyState(), cov);
    expect(count).toBe(0);
    expect(state).toEqual(emptyState());
  });
});
