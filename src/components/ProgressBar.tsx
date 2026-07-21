export interface Counts {
  pass: number;
  fail: number;
  skip: number;
  pending: number;
  total: number;
}

/** Segmented progress bar. Pending is the hollow track behind the fills. */
export function ProgressBar({ counts }: { counts: Counts }) {
  const pct = (n: number) => (counts.total ? (n / counts.total) * 100 : 0);
  return (
    <div class="segbar" role="img" aria-label={ariaLabel(counts)}>
      {counts.pass > 0 && <div class="seg pass" style={{ width: `${pct(counts.pass)}%` }} />}
      {counts.fail > 0 && <div class="seg fail" style={{ width: `${pct(counts.fail)}%` }} />}
      {counts.skip > 0 && <div class="seg skip" style={{ width: `${pct(counts.skip)}%` }} />}
    </div>
  );
}

export function CountsRow({ counts }: { counts: Counts }) {
  return (
    <div class="counts">
      <span class="c">
        <span class="dot pass" /> {counts.pass} pass
      </span>
      <span class="c">
        <span class="dot fail" /> {counts.fail} fail
      </span>
      <span class="c">
        <span class="dot skip" /> {counts.skip} skip
      </span>
      <span class="c">
        <span class="dot pending" /> {counts.pending} left
      </span>
    </div>
  );
}

function ariaLabel(c: Counts): string {
  return `${c.pass} passed, ${c.fail} failed, ${c.skip} skipped, ${c.pending} pending of ${c.total}`;
}
