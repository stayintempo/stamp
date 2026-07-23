// Fully synthetic "Coffee Machine QA" fixtures. Invented for tests only — no
// content is copied from any real checklist.

import type { SourceFile } from '../src/lib/types';

export const source = {
  owner: 'acme',
  repo: 'coffee-qa',
  ref: 'main',
  sha: 'abc1234def5678',
  path: 'QA',
};

export const rootReadme = `# Coffee Machine QA

Top-to-bottom manual pass for the office coffee machine. Folders run in order.

- Not a tracked step (this is the overview file).
`;

// README-only phase, H1 carries a [BLOCKING] badge, nested sub-checklist,
// a fenced code block that itself contains a checkbox (must be ignored),
// and a relative + app-host link.
export const brewingReadme = `# 1. Brewing [BLOCKING]

Warm up the machine before starting.

- [ ] **Power on.** Flip the switch on [the panel](https://machine.local/panel).
      The ready light turns green.
  - Confirm the tank has water.
  - [ ] sub: descaling light is off
- [ ] **Brew a single espresso.** Press the single-cup button.
  See [the manual](../MANUAL.md) for grind settings.

\`\`\`sh
# - [ ] this checkbox is inside a fence and must NOT be a step
brew --shot
\`\`\`

- [ ] **Check crema.** A thin layer of crema should form on top.
`;

// README-only phase with two section headings: the pre-first-step "## Daily" is
// intro, and the between-step "## Weekly" is a separator.
export const cleaningReadme = `# 2. Cleaning [INFORMATIONAL]

## Daily

- [ ] Rinse the portafilter under hot water.

## Weekly

- [ ] Backflush with the blind basket.
- [ ] Wipe the steam wand.
`;

// Numeric-file phase: each file is a step group. One file has checkboxes,
// one file has NO checkboxes (whole file = a single step).
export const maintenance01 = `# Descale

- [ ] **Mix descaler.** One sachet per litre.
- [ ] **Run descale cycle.** Hold both buttons for 3 seconds.
`;

export const maintenance02 = `# Replace Filter

The water filter is a whole-file instructional step with no checkboxes.
Replace it every two months. Record the date on the log sheet.
`;

/** Directory-style run: root README + two phase folders. */
export const dirFiles: SourceFile[] = [
  { path: 'QA/README.md', content: rootReadme },
  { path: 'QA/01_Brewing/README.md', content: brewingReadme },
  { path: 'QA/02_Cleaning/README.md', content: cleaningReadme },
];

/** A phase folder that uses numeric step-group files (no subfolders). */
export const numericPhaseFiles: SourceFile[] = [
  { path: 'QA/README.md', content: '# Maintenance Phase\n\nGrouped by task file.\n' },
  { path: 'QA/01-descale.md', content: maintenance01 },
  { path: 'QA/02-filter.md', content: maintenance02 },
];
