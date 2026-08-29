import type { BackupRunStatus } from 'engine-core';
import type { RunRow } from './runsClient';
import type { FileBackupRun } from './fileBackupClient';

/**
 * Shared row shape for the unified run history (Historial + the client
 * ficha's Historial/Backups tabs) — DB-dump runs (`backup_runs`) and
 * restic file-backup runs (`file_backup_runs`) merged, told apart by `kind`.
 */
export interface UnifiedRunRow {
  kind: 'db' | 'file';
  id: string;
  clientId: string;
  clientName: string | null;
  taskName: string | null;
  status: BackupRunStatus;
  startedAt: string;
  durationMs: number | null;
  /** DB: the dump's byte size. File: restic's deduped "data added" for that run. */
  sizeBytes: number | null;
  errorMessage: string | null;
  backupSetName: string | null;
  /** DB only — whether the dump file is still on disk (download/delete meaningful). */
  localFileExists: boolean;
  /** DB only — set even when the file was later deleted. */
  hadLocalPath: boolean;
  /** File only — the restic snapshot id (restore/delete meaningful when set). */
  snapshotId: string | null;
}

export function toUnifiedDbRun(r: RunRow): UnifiedRunRow {
  return {
    kind: 'db',
    id: r.id,
    clientId: r.clientId,
    clientName: r.clientName,
    taskName: r.taskName,
    status: r.status,
    startedAt: r.startedAt,
    durationMs: r.durationMs,
    sizeBytes: r.sizeBytes,
    errorMessage: r.errorMessage,
    backupSetName: r.backupSetName,
    localFileExists: Boolean(r.localFileExists),
    hadLocalPath: Boolean(r.localPath),
    snapshotId: null,
  };
}

export function toUnifiedFileRun(r: FileBackupRun): UnifiedRunRow {
  return {
    kind: 'file',
    id: r.id,
    clientId: r.clientId,
    clientName: r.clientName ?? null,
    taskName: r.taskName ?? null,
    status: r.status,
    startedAt: r.startedAt,
    durationMs: r.durationMs,
    sizeBytes: r.dataAdded,
    errorMessage: r.errorMessage,
    backupSetName: null,
    localFileExists: false,
    hadLocalPath: false,
    snapshotId: r.snapshotId,
  };
}

/** Both domains merged, newest first by startedAt. */
export function mergeRuns(dbRuns: RunRow[], fileRuns: FileBackupRun[]): UnifiedRunRow[] {
  return [...dbRuns.map(toUnifiedDbRun), ...fileRuns.map(toUnifiedFileRun)].sort((a, b) =>
    b.startedAt.localeCompare(a.startedAt)
  );
}
