import type { Database } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { ReplicationRun, ReplicationRunStatus, ReplicationTrigger } from '../../replication/types.js';

interface ReplicationRunRow {
  id: string;
  target_id: string;
  client_id: string;
  trigger: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  bytes_transferred: number | null;
  files_transferred: number | null;
  files_deleted: number | null;
  error_message: string | null;
  pid: number | null;
  created_at: string;
}

function toDomain(row: ReplicationRunRow): ReplicationRun {
  return {
    id: row.id,
    targetId: row.target_id,
    clientId: row.client_id,
    trigger: row.trigger as ReplicationTrigger,
    status: row.status as ReplicationRunStatus,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    bytesTransferred: row.bytes_transferred,
    filesTransferred: row.files_transferred,
    filesDeleted: row.files_deleted,
    errorMessage: row.error_message,
    pid: row.pid,
    createdAt: row.created_at,
  };
}

export interface CreateReplicationRunInput {
  targetId: string;
  clientId: string;
  trigger: ReplicationTrigger;
  pid: number;
}

export interface FinishReplicationRunInput {
  bytesTransferred?: number;
  filesTransferred?: number;
  filesDeleted?: number;
  errorMessage?: string;
}

export interface ReplicationRunsRepo {
  create(input: CreateReplicationRunInput): ReplicationRun;
  markFinished(runId: string, status: 'Success' | 'Warning' | 'Failed', opts?: FinishReplicationRunInput): void;
  getById(runId: string): ReplicationRun | null;
  listInProgressByTarget(targetId: string): ReplicationRun[];
  listRecent(opts?: { targetId?: string; clientId?: string; limit?: number }): ReplicationRun[];
}

export function createReplicationRunsRepo(db: Database): ReplicationRunsRepo {
  const insertStmt = db.prepare(
    `INSERT INTO replication_runs (id, target_id, client_id, trigger, status, started_at, pid)
     VALUES (@id, @targetId, @clientId, @trigger, 'Running', strftime('%Y-%m-%dT%H:%M:%fZ','now'), @pid)`
  );
  const getStmt = db.prepare<[string], ReplicationRunRow>('SELECT * FROM replication_runs WHERE id = ?');
  const markFinishedStmt = db.prepare(
    `UPDATE replication_runs
     SET status = @status,
         bytes_transferred = @bytesTransferred,
         files_transferred = @filesTransferred,
         files_deleted = @filesDeleted,
         error_message = @errorMessage,
         finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
         duration_ms = CAST((julianday(strftime('%Y-%m-%dT%H:%M:%fZ','now')) - julianday(started_at)) * 86400000 AS INTEGER)
     WHERE id = @runId`
  );
  const inProgressByTargetStmt = db.prepare<[string], ReplicationRunRow>(
    `SELECT * FROM replication_runs WHERE target_id = ? AND status = 'Running'`
  );
  const listRecentStmt = db.prepare<{ targetId: string | null; clientId: string | null; limit: number }, ReplicationRunRow>(
    `SELECT * FROM replication_runs
     WHERE (@targetId IS NULL OR target_id = @targetId)
       AND (@clientId IS NULL OR client_id = @clientId)
     ORDER BY started_at DESC, rowid DESC
     LIMIT @limit`
  );

  return {
    create(input) {
      const id = randomUUID();
      insertStmt.run({
        id,
        targetId: input.targetId,
        clientId: input.clientId,
        trigger: input.trigger,
        pid: input.pid,
      });
      const row = getStmt.get(id);
      if (!row) throw new Error(`Failed to read back created replication_run ${id}`);
      return toDomain(row);
    },

    markFinished(runId, status, opts) {
      markFinishedStmt.run({
        runId,
        status,
        bytesTransferred: opts?.bytesTransferred ?? null,
        filesTransferred: opts?.filesTransferred ?? null,
        filesDeleted: opts?.filesDeleted ?? null,
        errorMessage: opts?.errorMessage ?? null,
      });
    },

    getById(runId) {
      const row = getStmt.get(runId);
      return row ? toDomain(row) : null;
    },

    listInProgressByTarget(targetId) {
      return inProgressByTargetStmt.all(targetId).map(toDomain);
    },

    listRecent(opts) {
      return listRecentStmt
        .all({
          targetId: opts?.targetId ?? null,
          clientId: opts?.clientId ?? null,
          limit: opts?.limit ?? 200,
        })
        .map(toDomain);
    },
  };
}
