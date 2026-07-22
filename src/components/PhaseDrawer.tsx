import { useEffect } from 'preact/hooks';
import type { RunDoc } from '../lib/types';
import type { RunState } from '../lib/state';
import { PhaseNav } from './PhaseNav';

interface Props {
  doc: RunDoc;
  state: RunState;
  currentIndex: number;
  onJump: (globalIndex: number) => void;
  onClose: () => void;
}

/**
 * The phase navigator, on demand. STAMP runs in a ~400px window beside the app
 * under test, where an always-open accordion of every phase pushed the step card
 * — the only thing the tester acts on — below the fold. The header now carries a
 * one-line phase control that opens this; jumping closes it, so the run screen
 * is the step and nothing else.
 */
export function PhaseDrawer({ doc, state, currentIndex, onJump, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      class="overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Phases"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section class="overlay-panel drawer-panel">
        <div class="row drawer-head">
          <strong>Phases</strong>
          <button type="button" onClick={onClose} aria-label="Close phase list">
            ✕
          </button>
        </div>
        <PhaseNav
          doc={doc}
          state={state}
          currentIndex={currentIndex}
          onJump={(i) => {
            onJump(i);
            onClose();
          }}
        />
      </section>
    </div>
  );
}
