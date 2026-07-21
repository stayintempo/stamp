// Keyboard shortcut resolution for the run screen. Pure so the suppression rule
// (never act while typing in a field) is unit-testable without a live DOM.

export type KeyAction = 'pass' | 'fail' | 'skip' | 'prev' | 'next';

interface KeyEventish {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
}

interface Targetish {
  tagName?: string;
  isContentEditable?: boolean;
}

const TYPING_TAGS = /^(INPUT|TEXTAREA|SELECT)$/;

export function resolveKeyAction(e: KeyEventish, target: Targetish | null): KeyAction | null {
  if (target && (target.isContentEditable || TYPING_TAGS.test(target.tagName ?? ''))) return null;
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  switch (e.key) {
    case 'p':
      return 'pass';
    case 'f':
      return 'fail';
    case 's':
      return 'skip';
    case 'ArrowLeft':
      return 'prev';
    case 'ArrowRight':
      return 'next';
    default:
      return null;
  }
}
