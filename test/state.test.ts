import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildRunDoc, flattenSteps } from '../src/lib/parse';
import {
  serializeIssueBody,
  parseIssueBody,
  applyStateToBody,
  parseMarker,
  hasStampMarker,
  setStep,
  stepState,
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
import { source, dirFiles } from './fixtures';

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

  it('preserves a hand-edited step label while updating its checkbox', () => {
    let body = serializeIssueBody(doc, emptyState(), meta);
    body = body.replace('- [ ] Power on.', '- [ ] Power on (renamed by hand)');
    const s = stateWith({ 0: { status: 'pass' } });
    const merged = applyStateToBody(body, doc, s);
    expect(merged).toContain('- [x] Power on (renamed by hand)');
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
    // positional mapping: first task line -> first step, marked checked -> pass
    const flat = flattenSteps(doc);
    const parsed = parseIssueBody(weird, doc);
    expect(parsed.statuses[flat[0].step.id]?.status).toBe('pass');
  });
});

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
