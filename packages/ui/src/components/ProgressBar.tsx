import type { RunProgress } from 'engine-core';
import { formatProgressCount, formatEta } from '../lib/progress';

/**
 * A thin live-progress bar for an in-progress run. Determinate when
 * `progress.fraction` is a number (download %, restic %); indeterminate
 * (a sliding segment) when it's null (remote/local dump, connecting).
 * Callers gate on `isLiveProgress(status, progress)` before rendering this.
 */
export function ProgressBar({ progress }: { progress: RunProgress }) {
  const pct = progress.fraction != null ? Math.max(0, Math.min(1, progress.fraction)) : null;
  const count = formatProgressCount(progress);
  const eta = formatEta(progress.etaSeconds);
  const detail = [count, eta].filter(Boolean).join(' · ');

  return (
    <div className="mt-1 w-full max-w-md">
      <div
        className="relative h-1.5 overflow-hidden rounded-full"
        style={{ background: 'color-mix(in oklab, var(--accent) 18%, transparent)' }}
        role="progressbar"
        aria-valuenow={pct != null ? Math.round(pct * 100) : undefined}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        {pct != null ? (
          <div
            className="h-full rounded-full transition-[width] duration-500 ease-out"
            style={{ width: `${pct * 100}%`, background: 'var(--accent)' }}
          />
        ) : (
          <div className="arkode-indeterminate-bar" style={{ background: 'var(--accent)' }} />
        )}
      </div>
      <div className="mt-0.5 flex items-baseline justify-between gap-2 text-[11px]" style={{ color: 'var(--muted)' }}>
        <span className="truncate">{progress.label}</span>
        {detail && <span className="shrink-0 tabular-nums">{detail}</span>}
      </div>
    </div>
  );
}
