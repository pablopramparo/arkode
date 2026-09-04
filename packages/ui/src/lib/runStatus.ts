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
