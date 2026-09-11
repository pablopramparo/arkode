import type { DashboardRow } from './statusClient';
import { ageInHours } from './format';

/**
 * The exact message `runBackupTask`'s `recoverStaleRuns` and the file
 * domain's `recoverStaleRepositoryRuns` write when they reclaim a run whose
 * process died — an update, a reboot, a power cut, sleep/hibernate. The run
 * is recorded `Failed` (it produced no backup), but it is NOT a backup
 * failure: nothing was wrong with the config, the server, or the data, and
 * the next run resolves it with no action needed. The UI treats it softer.
 */
const INTERRUPT_RE = /interrupted: owning process is no longer alive/i;

export function isInterruptedRun(status: string, errorMessage: string | null | undefined): boolean {
  return status === 'Failed' && !!errorMessage && INTERRUPT_RE.test(errorMessage);
}

/** A friendlier line than the raw engine message, for the expandable error row. */
export function friendlyRunError(status: string, errorMessage: string | null | undefined): string | null {
  if (!errorMessage) return null;
  if (isInterruptedRun(status, errorMessage)) {
    return 'La corrida se cortó antes de terminar (una actualización, un reinicio o un corte de energía). No es una falla de backup — la próxima corrida lo resuelve sola, no requiere acción.';
  }
  return errorMessage;
}

/** A daily backup task without a fresh file past this age is worth flagging, even if the last *attempt* technically succeeded a while ago. */
export const STALE_THRESHOLD_HOURS = 26;

/**
 * Shared between the Dashboard (its "Necesita atención" list + red-flagged
 * rows) and the tray icon (its alert state + tooltip) — both need the exact
 * same "is this task actually a problem" judgment call, so it lives here
 * once instead of being redefined per consumer.
 */
export function isProblemRow(row: DashboardRow): boolean {
  // A task the user deliberately disabled has no freshness expectation at
  // all — it isn't running on any schedule, so a stale/missing/never-run
  // backup for it isn't a problem. Only a Failed/Warning from an actual
  // manual run is still worth surfacing.
  if (!row.scheduleEnabled) {
    return row.status === 'Failed' || row.status === 'Warning';
  }
  // An interrupted run (update / reboot / power cut) isn't a backup failure —
  // only flag it if the last *good* backup is also missing or stale.
  if (isInterruptedRun(row.status, row.latestErrorMessage)) {
    const hours = ageInHours(row.lastGoodBackupAt);
    return hours == null || hours > STALE_THRESHOLD_HOURS;
  }
  if (row.status === 'Failed' || row.status === 'Warning' || row.status === 'NeverRun') return true;
  const hours = ageInHours(row.lastGoodBackupAt);
  return hours != null && hours > STALE_THRESHOLD_HOURS;
}
