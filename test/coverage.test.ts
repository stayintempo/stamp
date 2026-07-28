import { describe, it, expect } from 'vitest';
import { parseCoverageLedger, preSeedReduced, MACHINE_COVERED_TAGS } from '../src/lib/coverage';
import { buildRunDoc, flattenSteps } from '../src/lib/parse';
import { emptyState, setStep } from '../src/lib/state';
import { idSource, idStepsV1 } from './fixtures';

const LEDGER = `# Coverage

Intro prose that is not a table.

## Per-box ledger

| Sec | # | Box (short lead label) | Tag | Owner | ID |
| --- | --- | --- | --- | --- | --- |
| 01 | 1 | Power on | CI | dev | qa:01.power |
| 01 | 2 | Brew espresso | SEED | dev | qa:02.brew |
| 02 | 1 | Check crema | CHECK | qa | qa:03.crema |
| 03 | 1 | Backticked cells | \`ci\` | dev | \`qa:04.tick\` |
| 02 | 2 | malformed missing cells |
| bad | row | with | far | too | many | cells |

## Some other section

| z | z | z | CI | z | qa:99.ignored |
`;

describe('parseCoverageLedger', () => {
  const map = parseCoverageLedger(LEDGER);

  it('maps each valid ledger row from stable id to its tag', () => {
    expect(map.get('qa:01.power')).toBe('CI');
    expect(map.get('qa:02.brew')).toBe('SEED');
    expect(map.get('qa:03.crema')).toBe('CHECK');
  });

  it('normalizes backticked cells and uppercases the tag', () => {
    expect(map.get('qa:04.tick')).toBe('CI');
  });

  it('skips malformed rows (wrong column count) without throwing', () => {
    // 3 valid + 1 backticked = 4; the two malformed rows are dropped.
    expect(map.size).toBe(4);
  });

  it('ignores tables outside the ledger section (heading-aware, negative)', () => {
    expect(map.has('qa:99.ignored')).toBe(false);
  });

  it('returns an empty map when there is no ledger section', () => {
    expect(parseCoverageLedger('# Doc\n\nNo ledger here.\n').size).toBe(0);
  });

  it('returns an empty map when the ledger heading has no table', () => {
    expect(parseCoverageLedger('## Per-box ledger\n\nComing soon.\n').size).toBe(0);
  });

  it('ignores a table nested in a fenced code block within the section', () => {
    const md = [
      '## Per-box ledger',
      '',
      '```',
      '| 01 | 1 | Fenced | CI | dev | qa:01.fenced |',
      '```',
      '',
      '| 01 | 2 | Real | SEED | dev | qa:01.real |',
    ].join('\n');
    const m = parseCoverageLedger(md);
    expect(m.has('qa:01.fenced')).toBe(false);
    expect(m.get('qa:01.real')).toBe('SEED');
  });
});

describe('preSeedReduced', () => {
  // idStepsV1 boxes: qa:01.power, qa:02.brew, and a third with no id.
  const doc = buildRunDoc(idSource, [{ path: 'QA/steps.md', content: idStepsV1 }]);
  const flat = flattenSteps(doc);

  it('treats only CI and SEED as machine-covered', () => {
    expect([...MACHINE_COVERED_TAGS].sort()).toEqual(['CI', 'SEED']);
  });

  it('auto-skips only CI/SEED boxes, tagging the note with the provenance', () => {
    // qa:01.power = CI (covered), qa:02.brew = CHECK (not covered).
    const cov = new Map([['qa:01.power', 'CI'], ['qa:02.brew', 'CHECK']]);
    const { state, count } = preSeedReduced(doc, emptyState(), cov);
    expect(count).toBe(1);
    expect(state.statuses[flat[0].step.id]).toEqual({ status: 'skip', note: 'auto: machine-covered (CI)' });
    // CHECK box and the id-less third box are untouched (negative).
    expect(state.statuses[flat[1].step.id]).toBeUndefined();
    expect(state.statuses[flat[2].step.id]).toBeUndefined();
  });

  it('never overwrites a step that already has a status', () => {
    const seeded0 = setStep(emptyState(), flat[0].step.id, { status: 'pass' });
    const cov = new Map([['qa:01.power', 'CI'], ['qa:02.brew', 'SEED']]);
    const { state, count } = preSeedReduced(doc, seeded0, cov);
    // box 0 already passed -> left alone; box 1 (SEED, pending) -> auto-skipped.
    expect(state.statuses[flat[0].step.id]).toEqual({ status: 'pass' });
    expect(state.statuses[flat[1].step.id]).toEqual({ status: 'skip', note: 'auto: machine-covered (SEED)' });
    expect(count).toBe(1);
  });

  it('an empty coverage map is a no-op', () => {
    const { state, count } = preSeedReduced(doc, emptyState(), new Map());
    expect(count).toBe(0);
    expect(state).toEqual(emptyState());
  });
});
