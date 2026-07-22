// The RunDoc model: the parsed, run-ordered representation of a QA checklist.
// parse.ts builds it from fetched markdown; the UI and state layers consume it.

export type PhaseBadge = 'BLOCKING' | 'INFORMATIONAL';

export interface Source {
  owner: string;
  repo: string;
  /** Symbolic ref as requested (branch/tag/sha), for display. */
  ref: string;
  /** Commit SHA the whole run is pinned to. */
  sha: string;
  /** Path within the repo the run was rooted at ('' for repo root). */
  path: string;
}

export interface Step {
  /** `{filePath}#{ordinal}-{shortHash}` — stable within a doc version. */
  id: string;
  /** Short human label (first bold span or first sentence, ~80 chars). */
  label: string;
  /** Rendered-as-markdown body of the step (item content, marker stripped). */
  bodyMarkdown: string;
  /** Heading / prose that appeared immediately before this step, if any. */
  separatorBefore?: string;
  /** Trailing prose/headings after the last step of a file, if any. */
  separatorAfter?: string;
}

export interface StepGroup {
  id: string;
  title?: string;
  /** Full repo path of the source file. */
  filePath: string;
  /** Markdown shown before the group's steps (per-file intro). */
  intro?: string;
  steps: Step[];
}

export interface Phase {
  id: string;
  title: string;
  badge?: PhaseBadge;
  /** Markdown shown before the phase's groups. */
  intro?: string;
  groups: StepGroup[];
}

export interface RunDoc {
  source: Source;
  /** Root README overview, shown as a collapsible preamble before phase 1. */
  preamble?: string;
  phases: Phase[];
}

/** A fetched markdown file: full repo path plus raw content. */
export interface SourceFile {
  path: string;
  content: string;
}
