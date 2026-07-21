import { describe, it, expect } from 'vitest';
import { resolveKeyAction } from '../src/lib/keys';

describe('resolveKeyAction', () => {
  it('maps the verdict and navigation keys', () => {
    expect(resolveKeyAction({ key: 'p' }, null)).toBe('pass');
    expect(resolveKeyAction({ key: 'f' }, null)).toBe('fail');
    expect(resolveKeyAction({ key: 's' }, null)).toBe('skip');
    expect(resolveKeyAction({ key: 'ArrowLeft' }, null)).toBe('prev');
    expect(resolveKeyAction({ key: 'ArrowRight' }, null)).toBe('next');
  });

  it('ignores unrelated keys', () => {
    expect(resolveKeyAction({ key: 'q' }, null)).toBeNull();
    expect(resolveKeyAction({ key: 'Enter' }, null)).toBeNull();
  });

  // --- suppression negatives ---
  it('is suppressed while typing in an input, textarea, or select', () => {
    expect(resolveKeyAction({ key: 'p' }, { tagName: 'INPUT' })).toBeNull();
    expect(resolveKeyAction({ key: 'f' }, { tagName: 'TEXTAREA' })).toBeNull();
    expect(resolveKeyAction({ key: 's' }, { tagName: 'SELECT' })).toBeNull();
  });

  it('is suppressed in contenteditable', () => {
    expect(resolveKeyAction({ key: 'p' }, { tagName: 'DIV', isContentEditable: true })).toBeNull();
  });

  it('is suppressed with a modifier held', () => {
    expect(resolveKeyAction({ key: 'p', metaKey: true }, null)).toBeNull();
    expect(resolveKeyAction({ key: 'p', ctrlKey: true }, null)).toBeNull();
  });
});
