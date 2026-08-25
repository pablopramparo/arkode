import type { Database } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { FileBackupRun, FileBackupRunStatus } from '../../types.js';

interface FileBackupRunRow {
  id: string;
  task_id: string;
  client_id: string;
  repository_id: string;
  status: string;
  snapshot_id: string | null;
  files_new: number | null;
  files_changed: number | null;
  files_unmodified: number | null;
  files_deleted: number | null;
  dirs_new: number | null;
  dirs_changed: number | null;
  total_files_processed: number | null;
  total_bytes_processed: number | null;
  data_added: number | null;
  data_added_packed: number | null;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  error_message: string | null;
  error_stack: string | null;
  warnings: string | null;
  log_file_path: string | null;
  pid: number | null;
  created_at: string;
}

function toDomain(row: FileBackupRunRow): FileBackupRun {
  return {
    id: row.id,
    taskId: row.task_id,
    clientId: row.client_id,
    repositoryId: row.repository_id,
    status: row.status as FileBackupRunStatus,
    snapshotId: row.snapshot_id,
    filesNew: row.files_new,
    filesChanged: row.files_changed,
    filesUnmodified: row.files_unmodified,
    filesDeleted: row.files_deleted,
    dirsNew: row.dirs_new,
    dirsChanged: row.dirs_changed,
    totalFilesProcessed: row.total_files_processed,
    totalBytesProcessed: row.total_bytes_processed,
    dataAdded: row.data_added,
    dataAddedPacked: row.data_added_packed,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    errorMessage: row.error_message,
    errorStack: row.error_stack,
    warnings: row.warnings ? (JSON.parse(row.warnings) as string[]) : null,
    logFilePath: row.log_file_path,
    pid: row.pid,
    createdAt: row.created_at,
  };
}

export interface CreateFileBackupRunInput {
  taskId: string;
  clientId: string;
  repositoryId: string;
  pid: number;
}

export interface RecordBackupSummaryInput {
  snapshotId: string;
  filesNew: number;
  filesChanged: number;
  filesUnmodified: number;
  filesDeleted: number;
  dirsNew: number;
  dirsChanged: number;
  totalFilesProcessed: number;
  totalBytesProcessed: number;
  dataAdded: number;
  dataAddedPacked: number;
  warnings: string[];
}

export interface FileBackupRunsRepo {
  create(input: CreateFileBackupRunInput): FileBackupRun;
  markProducing(runId: string): void;
  /** Moves to Validating and records every metric restic reported for this backup. */
  recordBackupSummary(runId: string, summary: RecordBackupSummaryInput): void;
  markFinished(runId: string, status: 'Success' | 'Warning' | 'Failed', opts?: { errorMessage?: string; errorStack?: string }): void;
  getById(runId: string): FileBackupRun | null;
  getLatestByTask(taskId: string): FileBackupRun | null;
  /** Most recent Success run that actually produced a snapshot — the baseline `restic diff` compares the next run against. */
  getLatestSuccessfulByTask(taskId: string): FileBackupRun | null;
  /** In-progress runs (Running/Producing/Validating) for every task sharing this repository — what the repository-level lock checks. */
  listInProgressByRepository(repositoryId: string): FileBackupRun[];
  listRecent(opts?: { taskId?: string; clientId?: string; limit?: number }): FileBackupRun[];
}

export function createFileBackupRunsRepo(db: Database): FileBackupRunsRepo {
  const insertStmt = db.prepare(
    `INSERT INTO file_backup_runs (id, task_id, client_id, repository_id, status, started_at, pid)
     VALUES (@id, @taskId, @clientId, @repositoryId, 'Pending', strftime('%Y-%m-%dT%H:%M:%fZ','now'), @pid)`
  );
  const getStmt = db.prepare<[string], FileBackupRunRow>('SELECT * FROM file_backup_runs WHERE id = ?');
  const setStatusStmt = db.prepare('UPDATE file_backup_runs SET status = ? WHERE id = ?');
  const markProducingStmt = db.prepare(`UPDATE file_backup_runs SET status = 'Producing' WHERE id = ?`);
  const recordSummaryStmt = db.prepare(
    `UPDATE file_backup_runs
     SET status = 'Validating',
         snapshot_id = @snapshotId,
         files_new = @filesNew, files_changed = @filesChanged, files_unmodified = @filesUnmodified, files_deleted = @filesDeleted,
         dirs_new = @dirsNew, dirs_changed = @dirsChanged,
         total_files_processed = @totalFilesProcessed, total_bytes_processed = @totalBytesProcessed,
         data_added = @dataAdded, data_added_packed = @dataAddedPacked,
         warnings = @warnings
     WHERE id = @runId`
  );
  const markFinishedStmt = db.prepare(
    `UPDATE file_backup_runs
     SET status = @status,
         error_message = @errorMessage,
         error_stack = @errorStack,
         finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
         duration_ms = CAST((julianday(strftime('%Y-%m-%dT%H:%M:%fZ','now')) - julianday(started_at)) * 86400000 AS INTEGER)
     WHERE id = @runId`
  );
  const getLatestByTaskStmt = db.prepare<[string], FileBackupRunRow>(
    'SELECT * FROM file_backup_runs WHERE task_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1'
  );
  const getLatestSuccessfulByTaskStmt = db.prepare<[string], FileBackupRunRow>(
    `SELECT * FROM file_backup_runs WHERE task_id = ? AND status = 'Success' AND snapshot_id IS NOT NULL
     ORDER BY started_at DESC, rowid DESC LIMIT 1`
  );
  const inProgressByRepositoryStmt = db.prepare<[string], FileBackupRunRow>(
    `SELECT * FROM file_backup_runs WHERE repository_id = ? AND status IN ('Running','Producing','Validating')`
  );
  const listRecentStmt = db.prepare<{ taskId: string | null; clientId: string | null; limit: number }, FileBackupRunRow>(
    `SELECT * FROM file_backup_runs
     WHERE (@taskId IS NULL OR task_id = @taskId)
       AND (@clientId IS NULL OR client_id = @clientId)
     ORDER BY started_at DESC, rowid DESC
     LIMIT @limit`
  );

  return {
    create(input) {
      const id = randomUUID();
      insertStmt.run({ id, taskId: input.taskId, clientId: input.clientId, repositoryId: input.repositoryId, pid: input.pid });
      setStatusStmt.run('Running', id);
      const row = getStmt.get(id);
      if (!row) throw new Error(`Failed to read back created file_backup_run ${id}`);
      return toDomain(row);
    },

    markProducing(runId) {
      markProducingStmt.run(runId);
    },

    recordBackupSummary(runId, summary) {
      recordSummaryStmt.run({
        runId,
        snapshotId: summary.snapshotId,
        filesNew: summary.filesNew,
        filesChanged: summary.filesChanged,
        filesUnmodified: summary.filesUnmodified,
        filesDeleted: summary.filesDeleted,
        dirsNew: summary.dirsNew,
        dirsChanged: summary.dirsChanged,
        totalFilesProcessed: summary.totalFilesProcessed,
        totalBytesProcessed: summary.totalBytesProcessed,
        dataAdded: summary.dataAdded,
        dataAddedPacked: summary.dataAddedPacked,
        warnings: summary.warnings.length > 0 ? JSON.stringify(summary.warnings) : null,
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

    getLatestSuccessfulByTask(taskId) {
      const row = getLatestSuccessfulByTaskStmt.get(taskId);
      return row ? toDomain(row) : null;
    },

    listInProgressByRepository(repositoryId) {
      return inProgressByRepositoryStmt.all(repositoryId).map(toDomain);
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
