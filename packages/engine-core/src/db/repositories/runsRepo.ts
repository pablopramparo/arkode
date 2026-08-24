import type { Database } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { BackupRun, BackupRunStatus } from '../../types.js';

interface BackupRunRow {
  id: string;
  task_id: string;
  client_id: string;
  strategy: string;
  transport_id: string | null;
  database_connection_id: string | null;
  status: string;
  remote_file_name: string | null;
  remote_path: string | null;
  remote_modified_at: string | null;
  started_at: string;
  finished_at: string | null;
  downloaded_at: string | null;
  local_path: string | null;
  size_bytes: number | null;
  checksum_sha256: string | null;
  duration_ms: number | null;
  error_message: string | null;
  error_stack: string | null;
  log_file_path: string | null;
  pid: number | null;
  created_at: string;
}

function toDomain(row: BackupRunRow): BackupRun {
  return {
    id: row.id,
    taskId: row.task_id,
    clientId: row.client_id,
    strategy: row.strategy as BackupRun['strategy'],
    transportId: row.transport_id,
    databaseConnectionId: row.database_connection_id,
    status: row.status as BackupRunStatus,
    remoteFileName: row.remote_file_name,
    remotePath: row.remote_path,
    remoteModifiedAt: row.remote_modified_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    downloadedAt: row.downloaded_at,
    localPath: row.local_path,
    sizeBytes: row.size_bytes,
    checksumSha256: row.checksum_sha256,
    durationMs: row.duration_ms,
    errorMessage: row.error_message,
    errorStack: row.error_stack,
    logFilePath: row.log_file_path,
    pid: row.pid,
    createdAt: row.created_at,
  };
}

export interface CreateRunInput {
  taskId: string;
  clientId: string;
  strategy: BackupRun['strategy'];
  transportId: string | null;
  databaseConnectionId: string | null;
  pid: number;
}

export interface SuccessfulFileSignature {
  remoteFileName: string;
  sizeBytes: number;
}

export interface RunsRepo {
  create(input: CreateRunInput): BackupRun;
  markProducing(runId: string): void;
  markValidating(runId: string, produced: { fileName: string; sizeBytes: number; sourceModifiedAt?: Date; checksumSha256: string; localPath: string }): void;
  markFinished(runId: string, status: 'Success' | 'Warning' | 'Failed', opts?: { errorMessage?: string; errorStack?: string }): void;
  getById(runId: string): BackupRun | null;
  getLatestByTask(taskId: string): BackupRun | null;
  /** Latest run that actually has a file on disk (Success or Warning) — for showing size/age of the last real backup, distinct from the latest attempt's status. */
  getLatestWithFileByTask(taskId: string): BackupRun | null;
  /** Signatures of Success runs for a task, used to avoid redundant re-downloads. */
  listSuccessfulFileSignatures(taskId: string): SuccessfulFileSignature[];
  /** Success runs for a task, newest first — the population retention operates over. */
  listSuccessfulRuns(taskId: string): BackupRun[];
  /** In-progress runs (Running/Producing/Validating) whose recorded pid may no longer be alive. */
  listInProgress(taskId?: string): BackupRun[];
  /** Every run (any status), newest first, optionally filtered — for a Historial view. Capped by `limit` (default 200) so a long-lived install never loads its entire history in one request. */
  listRecent(opts?: { taskId?: string; clientId?: string; limit?: number }): BackupRun[];
}

export function createRunsRepo(db: Database): RunsRepo {
  const insertStmt = db.prepare(
    `INSERT INTO backup_runs
       (id, task_id, client_id, strategy, transport_id, database_connection_id, status, started_at, pid)
     VALUES
       (@id, @taskId, @clientId, @strategy, @transportId, @databaseConnectionId, 'Pending', strftime('%Y-%m-%dT%H:%M:%fZ','now'), @pid)`
  );
  const getStmt = db.prepare<[string], BackupRunRow>('SELECT * FROM backup_runs WHERE id = ?');
  const getLatestByTaskStmt = db.prepare<[string], BackupRunRow>(
    'SELECT * FROM backup_runs WHERE task_id = ? ORDER BY started_at DESC LIMIT 1'
  );
  const getLatestWithFileByTaskStmt = db.prepare<[string], BackupRunRow>(
    `SELECT * FROM backup_runs WHERE task_id = ? AND local_path IS NOT NULL ORDER BY started_at DESC LIMIT 1`
  );
  const setStatusStmt = db.prepare('UPDATE backup_runs SET status = ? WHERE id = ?');
  const markProducingStmt = db.prepare(`UPDATE backup_runs SET status = 'Producing' WHERE id = ?`);
  const markValidatingStmt = db.prepare(
    `UPDATE backup_runs
     SET status = 'Validating',
         remote_file_name = @fileName,
         size_bytes = @sizeBytes,
         remote_modified_at = @sourceModifiedAt,
         checksum_sha256 = @checksumSha256,
         local_path = @localPath,
         downloaded_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = @runId`
  );
  const markFinishedStmt = db.prepare(
    `UPDATE backup_runs
     SET status = @status,
         error_message = @errorMessage,
         error_stack = @errorStack,
         finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
         duration_ms = CAST((julianday(strftime('%Y-%m-%dT%H:%M:%fZ','now')) - julianday(started_at)) * 86400000 AS INTEGER)
     WHERE id = @runId`
  );
  const successfulSignaturesStmt = db.prepare<[string], { remote_file_name: string; size_bytes: number }>(
    `SELECT remote_file_name, size_bytes FROM backup_runs
     WHERE task_id = ? AND status = 'Success' AND remote_file_name IS NOT NULL`
  );
  // local_path IS NOT NULL excludes "no new backup needed" no-op Success
  // runs (fetch_existing's NoNewDumpAvailableError path) — those don't
  // correspond to an actual file on disk and must never occupy a "kept
  // backup" slot for retention purposes.
  const successfulRunsStmt = db.prepare<[string], BackupRunRow>(
    `SELECT * FROM backup_runs WHERE task_id = ? AND status = 'Success' AND local_path IS NOT NULL ORDER BY started_at DESC`
  );
  const inProgressStmt = db.prepare<[string], BackupRunRow>(
    `SELECT * FROM backup_runs WHERE task_id = ? AND status IN ('Running','Producing','Validating')`
  );
  const inProgressAllStmt = db.prepare<[], BackupRunRow>(
    `SELECT * FROM backup_runs WHERE status IN ('Running','Producing','Validating')`
  );
  const listRecentStmt = db.prepare<{ taskId: string | null; clientId: string | null; limit: number }, BackupRunRow>(
    `SELECT * FROM backup_runs
     WHERE (@taskId IS NULL OR task_id = @taskId)
       AND (@clientId IS NULL OR client_id = @clientId)
     ORDER BY started_at DESC
     LIMIT @limit`
  );

  return {
    create(input) {
      const id = randomUUID();
      insertStmt.run({
        id,
        taskId: input.taskId,
        clientId: input.clientId,
        strategy: input.strategy,
        transportId: input.transportId,
        databaseConnectionId: input.databaseConnectionId,
        pid: input.pid,
      });
      setStatusStmt.run('Running', id);
      const row = getStmt.get(id);
      if (!row) throw new Error(`Failed to read back created backup_run ${id}`);
      return toDomain(row);
    },

    markProducing(runId) {
      markProducingStmt.run(runId);
    },

    markValidating(runId, produced) {
      markValidatingStmt.run({
        runId,
        fileName: produced.fileName,
        sizeBytes: produced.sizeBytes,
        sourceModifiedAt: produced.sourceModifiedAt ? produced.sourceModifiedAt.toISOString() : null,
        checksumSha256: produced.checksumSha256,
        localPath: produced.localPath,
      });
    },

    markFinished(runId, status, opts) {
      markFinishedStmt.run({
        runId,
        status,
        errorMessage: opts?.errorMessage ?? null,
        errorStack: opts?.errorStack ?? null,
      });
    },

    getById(runId) {
      const row = getStmt.get(runId);
      return row ? toDomain(row) : null;
    },

    getLatestByTask(taskId) {
      const row = getLatestByTaskStmt.get(taskId);
      return row ? toDomain(row) : null;
    },

    getLatestWithFileByTask(taskId) {
      const row = getLatestWithFileByTaskStmt.get(taskId);
      return row ? toDomain(row) : null;
    },

    listSuccessfulFileSignatures(taskId) {
      return successfulSignaturesStmt
        .all(taskId)
        .map((row) => ({ remoteFileName: row.remote_file_name, sizeBytes: row.size_bytes }));
    },

    listSuccessfulRuns(taskId) {
      return successfulRunsStmt.all(taskId).map(toDomain);
    },

    listInProgress(taskId) {
      const rows = taskId ? inProgressStmt.all(taskId) : inProgressAllStmt.all();
      return rows.map(toDomain);
    },

    listRecent(opts) {
      const rows = listRecentStmt.all({
        taskId: opts?.taskId ?? null,
        clientId: opts?.clientId ?? null,
        limit: opts?.limit ?? 200,
      });
      return rows.map(toDomain);
    },
  };
}
