import type { Database } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { RetentionDeletion } from '../../types.js';

interface RetentionDeletionRow {
  id: string;
  task_id: string;
  deleted_backup_run_id: string;
  triggered_by_run_id: string | null;
  local_path: string;
  size_bytes: number | null;
  reason: string;
  deleted_at: string;
}

function toDomain(row: RetentionDeletionRow): RetentionDeletion {
  return {
    id: row.id,
    taskId: row.task_id,
    deletedBackupRunId: row.deleted_backup_run_id,
    triggeredByRunId: row.triggered_by_run_id,
    localPath: row.local_path,
    sizeBytes: row.size_bytes,
    reason: row.reason,
    deletedAt: row.deleted_at,
  };
}

export interface CreateRetentionDeletionInput {
  taskId: string;
  deletedBackupRunId: string;
  triggeredByRunId: string | null;
  localPath: string;
  sizeBytes: number | null;
  reason: string;
}

export interface RetentionDeletionsRepo {
  create(input: CreateRetentionDeletionInput): RetentionDeletion;
  listByTask(taskId: string): RetentionDeletion[];
  /** backup_runs.id values already recorded as deleted for this task — never re-process these. */
  listDeletedRunIds(taskId: string): Set<string>;
}

export function createRetentionDeletionsRepo(db: Database): RetentionDeletionsRepo {
  const insertStmt = db.prepare(
    `INSERT INTO retention_deletions
       (id, task_id, deleted_backup_run_id, triggered_by_run_id, local_path, size_bytes, reason)
     VALUES
       (@id, @taskId, @deletedBackupRunId, @triggeredByRunId, @localPath, @sizeBytes, @reason)`
  );
  const getByIdStmt = db.prepare<[string], RetentionDeletionRow>('SELECT * FROM retention_deletions WHERE id = ?');
  const listByTaskStmt = db.prepare<[string], RetentionDeletionRow>(
    'SELECT * FROM retention_deletions WHERE task_id = ? ORDER BY deleted_at DESC'
  );
  const deletedRunIdsStmt = db.prepare<[string], { deleted_backup_run_id: string }>(
    'SELECT DISTINCT deleted_backup_run_id FROM retention_deletions WHERE task_id = ?'
  );

  return {
    create(input) {
      const id = randomUUID();
      insertStmt.run({
        id,
        taskId: input.taskId,
        deletedBackupRunId: input.deletedBackupRunId,
        triggeredByRunId: input.triggeredByRunId,
        localPath: input.localPath,
        sizeBytes: input.sizeBytes,
        reason: input.reason,
      });
      const row = getByIdStmt.get(id);
      if (!row) throw new Error(`Failed to read back created retention_deletion ${id}`);
      return toDomain(row);
    },

    listByTask(taskId) {
      return listByTaskStmt.all(taskId).map(toDomain);
    },

    listDeletedRunIds(taskId) {
      return new Set(deletedRunIdsStmt.all(taskId).map((row) => row.deleted_backup_run_id));
    },
  };
}
