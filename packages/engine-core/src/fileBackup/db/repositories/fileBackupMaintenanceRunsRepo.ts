import type { Database } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { FileBackupMaintenanceOperation, FileBackupMaintenanceRun, FileBackupMaintenanceStatus } from '../../types.js';

interface FileBackupMaintenanceRunRow {
  id: string;
  repository_id: string;
  operation: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  bytes_reclaimed: number | null;
  error_message: string | null;
  pid: number | null;
  created_at: string;
}

function toDomain(row: FileBackupMaintenanceRunRow): FileBackupMaintenanceRun {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    operation: row.operation as FileBackupMaintenanceOperation,
    status: row.status as FileBackupMaintenanceStatus,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    bytesReclaimed: row.bytes_reclaimed,
    errorMessage: row.error_message,
    pid: row.pid,
    createdAt: row.created_at,
  };
}

export interface CreateFileBackupMaintenanceRunInput {
  repositoryId: string;
  operation: FileBackupMaintenanceOperation;
  pid: number;
}

export interface FileBackupMaintenanceRunsRepo {
  create(input: CreateFileBackupMaintenanceRunInput): FileBackupMaintenanceRun;
  markFinished(runId: string, status: 'Success' | 'Warning' | 'Failed', opts?: { errorMessage?: string; bytesReclaimed?: number }): void;
  getById(runId: string): FileBackupMaintenanceRun | null;
  /** In-progress maintenance runs for this repository — the other half of the repository-level lock check, alongside FileBackupRunsRepo.listInProgressByRepository. */
  listInProgressByRepository(repositoryId: string): FileBackupMaintenanceRun[];
  listByRepository(repositoryId: string, limit?: number): FileBackupMaintenanceRun[];
}

export function createFileBackupMaintenanceRunsRepo(db: Database): FileBackupMaintenanceRunsRepo {
  const insertStmt = db.prepare(
    `INSERT INTO file_backup_maintenance_runs (id, repository_id, operation, status, started_at, pid)
     VALUES (@id, @repositoryId, @operation, 'Running', strftime('%Y-%m-%dT%H:%M:%fZ','now'), @pid)`
  );
  const getStmt = db.prepare<[string], FileBackupMaintenanceRunRow>('SELECT * FROM file_backup_maintenance_runs WHERE id = ?');
  const markFinishedStmt = db.prepare(
    `UPDATE file_backup_maintenance_runs
     SET status = @status,
         error_message = @errorMessage,
         bytes_reclaimed = @bytesReclaimed,
         finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
         duration_ms = CAST((julianday(strftime('%Y-%m-%dT%H:%M:%fZ','now')) - julianday(started_at)) * 86400000 AS INTEGER)
     WHERE id = @runId`
  );
  const inProgressByRepositoryStmt = db.prepare<[string], FileBackupMaintenanceRunRow>(
    `SELECT * FROM file_backup_maintenance_runs WHERE repository_id = ? AND status = 'Running'`
  );
  const listByRepositoryStmt = db.prepare<{ repositoryId: string; limit: number }, FileBackupMaintenanceRunRow>(
    `SELECT * FROM file_backup_maintenance_runs WHERE repository_id = @repositoryId ORDER BY started_at DESC, rowid DESC LIMIT @limit`
  );

  return {
    create(input) {
      const id = randomUUID();
      insertStmt.run({ id, repositoryId: input.repositoryId, operation: input.operation, pid: input.pid });
      const row = getStmt.get(id);
      if (!row) throw new Error(`Failed to read back created file_backup_maintenance_run ${id}`);
      return toDomain(row);
    },

    markFinished(runId, status, opts) {
      markFinishedStmt.run({
        runId,
        status,
        errorMessage: opts?.errorMessage ?? null,
        bytesReclaimed: opts?.bytesReclaimed ?? null,
      });
    },

    getById(runId) {
      const row = getStmt.get(runId);
      return row ? toDomain(row) : null;
    },

    listInProgressByRepository(repositoryId) {
      return inProgressByRepositoryStmt.all(repositoryId).map(toDomain);
    },

    listByRepository(repositoryId, limit = 50) {
      return listByRepositoryStmt.all({ repositoryId, limit }).map(toDomain);
    },
  };
}
