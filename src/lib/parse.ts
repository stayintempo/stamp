// parse.ts — turn a set of fetched markdown files into the RunDoc model.
//
// The checklist structure is derived line-oriented with fence awareness (NOT
// from marked's token stream) so the rules below are explicit and testable.
// See README.md "Checklist convention" for the format contract.

import type { Phase, PhaseBadge, RunDoc, Source, SourceFile, Step, StepGroup } from './types';
import { shortHash } from './hash';

// ---------------------------------------------------------------------------
// small path / string helpers
// ---------------------------------------------------------------------------

const naturalCompare = (a: string, b: string): number =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

const basename = (p: string): string => p.slice(p.lastIndexOf('/') + 1);

const stripMdExt = (name: string): string => name.replace(/\.md$/i, '');

const isReadme = (p: string): boolean => /^readme\.md$/i.test(basename(p));

// An ordered numeric prefix is digits FOLLOWED BY a separator ("00_", "01-",
// "2.") — not bare digits. This keeps "2fa-setup.md" a literal name rather than
// an ordered "fa-setup" step.
const NUMERIC_PREFIX_RE = /^\d+[-_.\s]/;

/** Whether a file/folder name carries an ordered numeric prefix. */
const hasNumericPrefix = (name: string): boolean =>
  NUMERIC_PREFIX_RE.test(stripMdExt(basename(name)));

/** "00_Operator_Setup" -> "Operator Setup"; "01-login" -> "login"; "2fa" -> "2fa". */
function humanize(name: string): string {
  const base = stripMdExt(name);
  const stripped = NUMERIC_PREFIX_RE.test(base) ? base.replace(/^\d+[-_.\s]+/, '') : base;
  return stripped.replace(/[-_]+/g, ' ').trim();
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

const BADGE_RE = /\s*\[(BLOCKING|INFORMATIONAL)\]\s*$/i;

function splitBadge(h1: string): { title: string; badge?: PhaseBadge } {
  const m = h1.match(BADGE_RE);
  if (!m) return { title: h1.trim() };
  return { title: h1.replace(BADGE_RE, '').trim(), badge: m[1].toUpperCase() as PhaseBadge };
}

/** First bold span, else first sentence; markdown-stripped, truncated ~80. */
export function extractLabel(text: string): string {
  const bold = text.match(/\*\*(.+?)\*\*/);
  let raw = bold ? bold[1] : (text.split(/(?<=[.!?])\s|\n/)[0] ?? text);
  raw = raw
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // [txt](url) -> txt
    .replace(/[*`_]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return raw.length > 80 ? raw.slice(0, 79).trimEnd() + '…' : raw;
}

// ---------------------------------------------------------------------------
// line-oriented file parser
// ---------------------------------------------------------------------------

interface ParsedStep {
  raw: string;
  label: string;
  body: string;
  separatorBefore?: string;
}

export interface ParsedFile {
  h1?: string;
  title?: string;
  badge?: PhaseBadge;
  /** Markdown before the first step (excludes the H1 line). */
  intro?: string;
  /** Trailing prose/headings after the last step (e.g. a "## Troubleshooting"). */
  trailer?: string;
  steps: ParsedStep[];
}

const FENCE_RE = /^\s*(`{3,}|~{3,})/;
const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
// A top-level task item: marker at column 0, no leading whitespace.
const TASK_RE = /^[-*+]\s+\[[ xX]\]\s+.*$/;
const TASK_PREFIX_RE = /^[-*+]\s+\[[ xX]\]\s?/;

function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === '') start++;
  while (end > start && lines[end - 1].trim() === '') end--;
  return lines.slice(start, end);
}

function finalizeStep(stepLines: string[], separatorBefore: string | undefined): ParsedStep {
  const first = stepLines[0];
  const markerLen = first.match(TASK_PREFIX_RE)?.[0].length ?? 0;
  const firstContent = first.slice(markerLen);
  const rest = stepLines.slice(1).map((line) => {
    // Remove up to markerLen leading spaces so aligned continuations dedent to
    // the margin and shallow-nested bullets rise to the top level of the body.
    let cut = 0;
    while (cut < markerLen && line[cut] === ' ') cut++;
    return line.slice(cut);
  });
  const body = trimBlankEdges([firstContent, ...rest]).join('\n');
  return { raw: stepLines.join('\n'), label: extractLabel(firstContent), body, separatorBefore };
}

export function parseFileSteps(markdown: string): ParsedFile {
  const lines = markdown.split(/\r?\n/);
  const result: ParsedFile = { steps: [] };

  let inFence = false;
  let fenceRun = '';
  let mode: 'pre' | 'step' = 'pre';
  const introLines: string[] = [];
  let stepLines: string[] = [];
  let sepLines: string[] = [];
  let currentSeparator: string | undefined;

  const flushStep = () => {
    if (stepLines.length === 0) return;
    result.steps.push(finalizeStep(stepLines, currentSeparator));
    stepLines = [];
    currentSeparator = undefined;
  };

  const pushToActive = (line: string) => {
    if (mode === 'step') stepLines.push(line);
    else if (sepLines.length > 0) sepLines.push(line);
    else introLines.push(line);
  };

  for (const line of lines) {
    const fenceMatch = line.match(FENCE_RE);
    if (fenceMatch) {
      const run = fenceMatch[1];
      // A closing fence uses the same fence char, is at least as long, and (per
      // CommonMark) carries NO info string. Without the info-string check a line
      // like ```bash inside an open fence would falsely close it and invert the
      // fence state, swallowing later steps.
      const rest = line.slice(fenceMatch[0].length).trim();
      if (!inFence) {
        inFence = true;
        fenceRun = run;
      } else if (run[0] === fenceRun[0] && run.length >= fenceRun.length && rest === '') {
        inFence = false;
      }
      pushToActive(line);
      continue;
    }
    if (inFence) {
      pushToActive(line);
      continue;
    }

    const heading = line.match(HEADING_RE);
    if (heading) {
      const level = heading[1].length;
      if (level === 1 && result.h1 === undefined && mode === 'pre' && result.steps.length === 0) {
        result.h1 = heading[2].trim();
        const sb = splitBadge(result.h1);
        result.title = sb.title;
        result.badge = sb.badge;
        continue;
      }
      // Any other heading terminates the current step and stands as a separator.
      if (mode === 'step') flushStep();
      mode = 'pre';
      sepLines.push(line);
      continue;
    }

    if (TASK_RE.test(line)) {
      if (mode === 'step') flushStep();
      currentSeparator = trimBlankEdges(sepLines).join('\n') || undefined;
      sepLines = [];
      mode = 'step';
      stepLines = [line];
      continue;
    }

    pushToActive(line);
  }

  if (mode === 'step') flushStep();

  result.intro = trimBlankEdges(introLines).join('\n') || undefined;
  // Any separator content still buffered after the last step is trailing prose
  // (e.g. a closing "## Troubleshooting"); keep it rather than dropping it.
  const trailer = trimBlankEdges(sepLines).join('\n') || undefined;
  if (trailer) result.trailer = trailer;
  return result;
}

// ---------------------------------------------------------------------------
// RunDoc assembly
// ---------------------------------------------------------------------------

const normText = (s: string): string => s.trim().replace(/\s+/g, ' ');

function groupFromParsed(parsed: ParsedFile, filePath: string): StepGroup {
  const title = parsed.title ?? humanize(basename(filePath));

  if (parsed.steps.length === 0) {
    // A file with no checkboxes is itself a single step; include any trailing
    // content so nothing after the intro is dropped.
    const body = [parsed.intro, parsed.trailer].filter(Boolean).join('\n\n');
    const step: Step = {
      id: `${filePath}#1-${shortHash(normText(body || title))}`,
      label: title,
      bodyMarkdown: body,
    };
    return { id: slug(filePath), title, filePath, steps: [step] };
  }

  const steps: Step[] = parsed.steps.map((s, i) => ({
    id: `${filePath}#${i + 1}-${shortHash(normText(s.raw))}`,
    label: s.label,
    bodyMarkdown: s.body,
    ...(s.separatorBefore ? { separatorBefore: s.separatorBefore } : {}),
  }));
  // Attach trailing content after the last step so it renders as a closing note.
  if (parsed.trailer && steps.length > 0) {
    steps[steps.length - 1] = { ...steps[steps.length - 1], separatorAfter: parsed.trailer };
  }

  return {
    id: slug(filePath),
    title,
    filePath,
    ...(parsed.intro ? { intro: parsed.intro } : {}),
    steps,
  };
}

function buildPhaseFromFolder(
  files: SourceFile[],
  folderName: string,
  folderPath: string,
): Phase {
  const readme = files.find((f) => isReadme(f.path));
  const numeric = files
    .filter((f) => !isReadme(f.path) && hasNumericPrefix(f.path))
    .sort((a, b) => naturalCompare(basename(a.path), basename(b.path)));

  let title: string | undefined;
  let badge: PhaseBadge | undefined;
  let intro: string | undefined;
  const groups: StepGroup[] = [];

  if (numeric.length > 0) {
    if (readme) {
      const rp = parseFileSteps(readme.content);
      title = rp.title;
      badge = rp.badge;
      intro = rp.intro;
    }
    for (const f of numeric) {
      const parsed = parseFileSteps(f.content);
      if (title === undefined) {
        title = parsed.title;
        badge = parsed.badge;
      }
      groups.push(groupFromParsed(parsed, f.path));
    }
  } else if (readme) {
    // The README is the sole step group; its pre-step content is the phase intro.
    const parsed = parseFileSteps(readme.content);
    title = parsed.title;
    badge = parsed.badge;
    intro = parsed.intro;
    const group = groupFromParsed(parsed, readme.path);
    delete group.intro; // hoisted to the phase
    groups.push(group);
  } else {
    // Fallback: no README and no numeric files — every .md becomes a group.
    const mds = files
      .filter((f) => /\.md$/i.test(f.path))
      .sort((a, b) => naturalCompare(basename(a.path), basename(b.path)));
    for (const f of mds) {
      const parsed = parseFileSteps(f.content);
      if (title === undefined) {
        title = parsed.title;
        badge = parsed.badge;
      }
      groups.push(groupFromParsed(parsed, f.path));
    }
  }

  return {
    id: slug(folderPath || folderName),
    title: title ?? humanize(folderName),
    ...(badge ? { badge } : {}),
    ...(intro ? { intro } : {}),
    groups,
  };
}

/** Files whose path sits directly in `dir` (exactly one path segment below). */
function directChildren(files: SourceFile[], dir: string): SourceFile[] {
  const prefix = dir ? dir + '/' : '';
  return files.filter((f) => {
    if (!f.path.startsWith(prefix)) return false;
    const rel = f.path.slice(prefix.length);
    return rel.length > 0 && !rel.includes('/');
  });
}

/** First-segment subdirectory names that contain files under `dir`. */
function subdirsUnder(files: SourceFile[], dir: string): string[] {
  const prefix = dir ? dir + '/' : '';
  const set = new Set<string>();
  for (const f of files) {
    if (!f.path.startsWith(prefix)) continue;
    const rel = f.path.slice(prefix.length);
    const slash = rel.indexOf('/');
    if (slash > 0) set.add(rel.slice(0, slash));
  }
  return [...set].sort(naturalCompare);
}

/**
 * Build the RunDoc from a resolved source and the markdown files fetched under
 * its path. `files` should contain every `.md` at or below `source.path`.
 */
export function buildRunDoc(source: Source, files: SourceFile[]): RunDoc {
  const root = source.path.replace(/^\/+|\/+$/g, '');

  // Blob URL to a single .md file: one phase, one group.
  const single = files.find((f) => f.path === root);
  if (root.toLowerCase().endsWith('.md') && single) {
    const parsed = parseFileSteps(single.content);
    const group = groupFromParsed(parsed, single.path);
    delete group.intro;
    const phase: Phase = {
      id: slug(single.path),
      title: parsed.title ?? humanize(basename(single.path)),
      ...(parsed.badge ? { badge: parsed.badge } : {}),
      ...(parsed.intro ? { intro: parsed.intro } : {}),
      groups: [group],
    };
    return { source, phases: [phase] };
  }

  const subdirs = subdirsUnder(files, root);

  if (subdirs.length > 0) {
    const loose = directChildren(files, root);
    const rootReadme = loose.find((f) => isReadme(f.path));
    const phases = subdirs.map((sub) => {
      const folderPath = root ? `${root}/${sub}` : sub;
      const folderFiles = directChildren(files, folderPath);
      return buildPhaseFromFolder(folderFiles, sub, folderPath);
    });
    return {
      source,
      ...(rootReadme ? { preamble: rootReadme.content } : {}),
      phases,
    };
  }

  // No subdirectories: the directory itself is a single phase.
  const folderFiles = directChildren(files, root);
  const folderName = root ? basename(root) : source.repo;
  return { source, phases: [buildPhaseFromFolder(folderFiles, folderName, root)] };
}

/** Flatten a RunDoc's steps in run order (phase → group → step). */
export function flattenSteps(doc: RunDoc): Array<{ phase: Phase; group: StepGroup; step: Step }> {
  const out: Array<{ phase: Phase; group: StepGroup; step: Step }> = [];
  for (const phase of doc.phases)
    for (const group of phase.groups)
      for (const step of group.steps) out.push({ phase, group, step });
  return out;
}
