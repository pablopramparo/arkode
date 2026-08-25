import type { Database } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { FileBackupRetentionDeletion } from '../../types.js';

interface FileBackupRetentionDeletionRow {
  id: string;
  task_id: string;
  forgotten_snapshot_id: string;
  triggered_by_run_id: string | null;
  reason: string;
  forgotten_at: string;
}

function toDomain(row: FileBackupRetentionDeletionRow): FileBackupRetentionDeletion {
  return {
    id: row.id,
    taskId: row.task_id,
    forgottenSnapshotId: row.forgotten_snapshot_id,
    triggeredByRunId: row.triggered_by_run_id,
    reason: row.reason,
    forgottenAt: row.forgotten_at,
  };
}

export interface CreateFileBackupRetentionDeletionInput {
  taskId: string;
  forgottenSnapshotId: string;
  triggeredByRunId: string | null;
  reason: string;
}

export interface FileBackupRetentionDeletionsRepo {
  create(input: CreateFileBackupRetentionDeletionInput): FileBackupRetentionDeletion;
  listByTask(taskId: string): FileBackupRetentionDeletion[];
}

export function createFileBackupRetentionDeletionsRepo(db: Database): FileBackupRetentionDeletionsRepo {
  const insertStmt = db.prepare(
    `INSERT INTO file_backup_retention_deletions (id, task_id, forgotten_snapshot_id, triggered_by_run_id, reason)
     VALUES (@id, @taskId, @forgottenSnapshotId, @triggeredByRunId, @reason)`
  );
  const getByIdStmt = db.prepare<[string], FileBackupRetentionDeletionRow>(
    'SELECT * FROM file_backup_retention_deletions WHERE id = ?'
  );
  const listByTaskStmt = db.prepare<[string], FileBackupRetentionDeletionRow>(
    'SELECT * FROM file_backup_retention_deletions WHERE task_id = ? ORDER BY forgotten_at DESC'
  );

  return {
    create(input) {
      const id = randomUUID();
      insertStmt.run({
        id,
        taskId: input.taskId,
        forgottenSnapshotId: input.forgottenSnapshotId,
        triggeredByRunId: input.triggeredByRunId,
        reason: input.reason,
      });
      const row = getByIdStmt.get(id);
      if (!row) throw new Error(`Failed to read back created file_backup_retention_deletion ${id}`);
      return toDomain(row);
    },

    listByTask(taskId) {
      return listByTaskStmt.all(taskId).map(toDomain);
    },
  };
}
