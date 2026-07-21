import { describe, it, expect } from 'vitest';
import { buildRunDoc, parseFileSteps, extractLabel, flattenSteps } from '../src/lib/parse';
import type { Source } from '../src/lib/types';
import {
  source,
  dirFiles,
  numericPhaseFiles,
  brewingReadme,
  cleaningReadme,
} from './fixtures';

const src: Source = source;

describe('parseFileSteps', () => {
  it('extracts H1 title and BLOCKING badge', () => {
    const p = parseFileSteps(brewingReadme);
    expect(p.title).toBe('1. Brewing');
    expect(p.badge).toBe('BLOCKING');
  });

  it('captures pre-step content as intro (excluding the H1 line)', () => {
    const p = parseFileSteps(brewingReadme);
    expect(p.intro).toContain('Warm up the machine');
    expect(p.intro).not.toContain('# 1. Brewing');
  });

  it('ignores checkboxes inside fenced code blocks (negative)', () => {
    const p = parseFileSteps(brewingReadme);
    // Power on, Brew a single espresso, Check crema — the fenced `- [ ]` is NOT one.
    expect(p.steps).toHaveLength(3);
    expect(p.steps.map((s) => s.label)).toEqual(['Power on.', 'Brew a single espresso.', 'Check crema.']);
  });

  it('keeps nested checkboxes inside the step body, not as tracked steps', () => {
    const p = parseFileSteps(brewingReadme);
    const powerOn = p.steps[0];
    expect(powerOn.body).toContain('descaling light is off');
    // The nested checkbox rises to a top-level task item within the body markdown.
    expect(powerOn.body).toMatch(/- \[ \] sub: descaling light is off/);
  });

  it('treats ## / ### headings between steps as separators', () => {
    const p = parseFileSteps(cleaningReadme);
    expect(p.steps).toHaveLength(3);
    expect(p.steps[0].separatorBefore).toContain('## Daily');
    expect(p.steps[1].separatorBefore).toContain('## Weekly');
    expect(p.steps[2].separatorBefore).toBeUndefined();
  });

  it('a file with no checkboxes yields zero parsed steps (whole-file handled upstream)', () => {
    const p = parseFileSteps('# Just Prose\n\nNo checkboxes here at all.');
    expect(p.steps).toHaveLength(0);
    expect(p.title).toBe('Just Prose');
  });

  it('ignores malformed task items (missing space, no brackets)', () => {
    const md = [
      '# T',
      '-[ ] no space after marker',
      '- [] empty brackets',
      '- [ ] real step',
      '  - [ ] indented (nested, not top-level)',
    ].join('\n');
    const p = parseFileSteps(md);
    expect(p.steps).toHaveLength(1);
    expect(p.steps[0].label).toContain('real step');
  });

  it('parses pre-checked [x] items as steps (still pending template)', () => {
    const p = parseFileSteps('# T\n- [x] already ticked in the template');
    expect(p.steps).toHaveLength(1);
  });
});

describe('extractLabel', () => {
  it('prefers the first bold span', () => {
    expect(extractLabel('**Power on.** Flip the switch.')).toBe('Power on.');
  });

  it('with multiple bold spans, uses the first', () => {
    expect(extractLabel('**First label** and **second label** follow.')).toBe('First label');
  });

  it('falls back to the first sentence and strips link syntax', () => {
    expect(extractLabel('Open [the panel](https://x/y) now. Then wait.')).toBe('Open the panel now.');
  });

  it('truncates long labels to ~80 chars with an ellipsis', () => {
    const label = extractLabel('x'.repeat(200));
    expect(label.length).toBeLessThanOrEqual(80);
    expect(label.endsWith('…')).toBe(true);
  });

  it('preserves unicode in labels', () => {
    expect(extractLabel('**Café ☕ ready.** Enjoy.')).toBe('Café ☕ ready.');
  });
});

describe('parser edge cases', () => {
  it('natural sort orders 2 before 10 across phase folders', () => {
    const files = [
      { path: 'QA/2_two/README.md', content: '# Two\n- [ ] a' },
      { path: 'QA/10_ten/README.md', content: '# Ten\n- [ ] b' },
      { path: 'QA/1_one/README.md', content: '# One\n- [ ] c' },
    ];
    const doc = buildRunDoc(src, files);
    expect(doc.phases.map((p) => p.title)).toEqual(['One', 'Two', 'Ten']);
  });

  it('when a folder has BOTH numeric files and a README, numeric files are the groups', () => {
    const files = [
      { path: 'QA/README.md', content: '# Maint\n\nintro prose' },
      { path: 'QA/01-a.md', content: '# A\n- [ ] step a' },
      { path: 'QA/02-b.md', content: '# B\n- [ ] step b' },
    ];
    const doc = buildRunDoc(src, files);
    expect(doc.phases[0].title).toBe('Maint');
    expect(doc.phases[0].intro).toContain('intro prose');
    expect(doc.phases[0].groups.map((g) => g.filePath)).toEqual(['QA/01-a.md', 'QA/02-b.md']);
  });

  it('handles CRLF line endings', () => {
    const p = parseFileSteps('# T\r\n\r\n- [ ] **Win step.** ok\r\n  - nested\r\n');
    expect(p.title).toBe('T');
    expect(p.steps).toHaveLength(1);
    expect(p.steps[0].label).toBe('Win step.');
    expect(p.steps[0].body).toContain('nested');
  });

  it('disambiguates duplicate step text by ordinal in the id', () => {
    const p = 'QA/dup.md';
    const doc = buildRunDoc(src, [{ path: p, content: '# D\n- [ ] same text\n- [ ] same text' }]);
    const ids = flattenSteps(doc).map((x) => x.step.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2); // unique despite identical text
    expect(ids[0]).toContain('#1-');
    expect(ids[1]).toContain('#2-');
  });

  it('humanizes a folder name when no H1 is present', () => {
    const doc = buildRunDoc(src, [{ path: 'QA/00_Operator_Setup/README.md', content: '- [ ] no heading here' }]);
    expect(doc.phases[0].title).toBe('Operator Setup');
  });

  it('does not crash on an empty file set', () => {
    const doc = buildRunDoc(src, []);
    expect(doc.phases).toHaveLength(1);
    expect(doc.phases[0].groups).toHaveLength(0);
  });

  it('produces an empty phase when a folder has only non-markdown files', () => {
    const doc = buildRunDoc(src, [
      { path: 'QA/01_x/logo.png' as string, content: 'binary' },
      { path: 'QA/02_y/README.md', content: '# Y\n- [ ] real' },
    ]);
    const x = doc.phases.find((p) => p.id.includes('01-x'));
    expect(x?.groups).toHaveLength(0);
    const y = doc.phases.find((p) => p.title === 'Y')!;
    expect(y.groups[0].steps).toHaveLength(1);
  });
});

describe('H1 badge variants', () => {
  const cases: Array<[string, string, string | undefined]> = [
    ['# 1. Auth [BLOCKING]', '1. Auth', 'BLOCKING'],
    ['# 2. Notes [INFORMATIONAL]', '2. Notes', 'INFORMATIONAL'],
    ['# 3. Plain title', '3. Plain title', undefined],
    ['# 4. Bracketed [but not a badge]', '4. Bracketed [but not a badge]', undefined],
  ];
  for (const [h1, title, badge] of cases) {
    it(`${h1} -> title="${title}" badge=${badge}`, () => {
      const p = parseFileSteps(`${h1}\n\n- [ ] x`);
      expect(p.title).toBe(title);
      expect(p.badge).toBe(badge);
    });
  }
});

describe('buildRunDoc (directory with subfolders)', () => {
  const doc = buildRunDoc(src, dirFiles);

  it('uses the root README as the preamble', () => {
    expect(doc.preamble).toContain('Top-to-bottom manual pass');
  });

  it('creates one phase per subfolder, in natural sort order', () => {
    expect(doc.phases.map((p) => p.title)).toEqual(['1. Brewing', '2. Cleaning']);
    expect(doc.phases[0].badge).toBe('BLOCKING');
    expect(doc.phases[1].badge).toBe('INFORMATIONAL');
  });

  it('gives every step a stable id of shape {filePath}#{ordinal}-{8hex}', () => {
    const ids = flattenSteps(doc).map((x) => x.step.id);
    for (const id of ids) expect(id).toMatch(/^QA\/.+#\d+-[0-9a-f]{8}$/);
    // ids are unique
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('is deterministic: rebuilding yields identical step ids', () => {
    const again = buildRunDoc(src, dirFiles);
    expect(flattenSteps(again).map((x) => x.step.id)).toEqual(
      flattenSteps(doc).map((x) => x.step.id),
    );
  });
});

describe('buildRunDoc (numeric step-group files)', () => {
  const doc = buildRunDoc(src, numericPhaseFiles);

  it('produces a single phase whose title comes from the folder README', () => {
    expect(doc.phases).toHaveLength(1);
    expect(doc.phases[0].title).toBe('Maintenance Phase');
  });

  it('makes each numeric file a step group', () => {
    const groups = doc.phases[0].groups;
    expect(groups.map((g) => g.filePath)).toEqual(['QA/01-descale.md', 'QA/02-filter.md']);
  });

  it('turns a checkbox-free file into a single whole-file step', () => {
    const filterGroup = doc.phases[0].groups.find((g) => g.filePath === 'QA/02-filter.md')!;
    expect(filterGroup.steps).toHaveLength(1);
    expect(filterGroup.steps[0].label).toBe('Replace Filter');
    expect(filterGroup.steps[0].bodyMarkdown).toContain('every two months');
  });
});
