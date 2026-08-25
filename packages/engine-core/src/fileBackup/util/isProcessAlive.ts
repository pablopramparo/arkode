/**
 * Deliberately duplicated from orchestrator/runBackupTask.ts rather than
 * imported/shared — see fileBackup's module-level note on why nothing in
 * this domain touches the tested DB-backup code, even to reuse a five-line
 * helper.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we lack permission to signal it —
    // still alive. Any other error (ESRCH, etc.) means it's gone.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
