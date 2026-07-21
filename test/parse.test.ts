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

  it('falls back to the first sentence and strips link syntax', () => {
    expect(extractLabel('Open [the panel](https://x/y) now. Then wait.')).toBe('Open the panel now.');
  });

  it('truncates long labels to ~80 chars with an ellipsis', () => {
    const label = extractLabel('x'.repeat(200));
    expect(label.length).toBeLessThanOrEqual(80);
    expect(label.endsWith('…')).toBe(true);
  });
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
