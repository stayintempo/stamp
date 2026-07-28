import { describe, it, expect } from 'vitest';
import { parseCoverageLedger } from '../src/lib/coverage';

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
