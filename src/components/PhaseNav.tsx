import { useState } from 'preact/hooks';
import type { RunDoc } from '../lib/types';
import type { RunState, PhaseSummary } from '../lib/state';
import { stepState, summarize } from '../lib/state';
import { ProgressBar } from './ProgressBar';

interface Props {
  doc: RunDoc;
  state: RunState;
  currentIndex: number;
  onJump: (globalIndex: number) => void;
}

/** The phase holding a global step index, so the nav opens where you are. */
function phaseIdAt(doc: RunDoc, globalIndex: number): string | null {
  let seen = 0;
  for (const phase of doc.phases) {
    seen += phase.groups.reduce((n, g) => n + g.steps.length, 0);
    if (globalIndex < seen) return phase.id;
  }
  return null;
}

/** Accordion of phases; expanding a phase lists its steps for direct jumps. */
export function PhaseNav({ doc, state, currentIndex, onJump }: Props) {
  const summary = summarize(doc, state);
  const byId = new Map<string, PhaseSummary>(summary.phases.map((p) => [p.id, p]));
  // Start on the current phase: the nav is opened on demand from the header, so
  // landing collapsed would cost a click to get back to where you already are.
  const [open, setOpen] = useState<string | null>(phaseIdAt(doc, currentIndex));

  // Precompute the global step index at the start of each phase.
  let running = 0;
  return (
    <nav class="phasenav">
      {doc.phases.map((phase) => {
        const base = running;
        const steps = phase.groups.flatMap((g) => g.steps);
        running += steps.length;
        const ps = byId.get(phase.id)!;
        const isOpen = open === phase.id;
        return (
          <div class="phase-row" key={phase.id}>
            <button class="phase-head" onClick={() => setOpen(isOpen ? null : phase.id)} aria-expanded={isOpen}>
              <span class="pt">{phase.title}</span>
              {phase.badge && (
                <span class={`badge ${phase.badge.toLowerCase()}`}>{phase.badge === 'BLOCKING' ? 'BLK' : 'INFO'}</span>
              )}
              <span class="mini">
                <ProgressBar counts={ps} />
              </span>
            </button>
            {isOpen && (
              <div class="phase-steps">
                {steps.map((step, i) => {
                  const gi = base + i;
                  const st = stepState(state, step.id).status;
                  return (
                    <button
                      key={step.id}
                      class={gi === currentIndex ? 'current' : ''}
                      onClick={() => onJump(gi)}
                    >
                      <span class={`dot ${st}`} />
                      <span class="lbl">{step.label}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}
