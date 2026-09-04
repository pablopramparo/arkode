import type { Database } from 'better-sqlite3';
import type { LogEvent, LogEventLevel, ListLogEventsOptions } from '../../../db/repositories/logEventsRepo.js';

interface FileBackupLogEventRow {
  id: number;
  run_id: string | null;
  level: string;
  step: string | null;
  message: string;
  created_at: string;
}

function toDomain(row: FileBackupLogEventRow): LogEvent {
  return {
    id: row.id,
    runId: row.run_id,
    level: row.level as LogEventLevel,
    step: row.step,
    message: row.message,
    createdAt: row.created_at,
  };
}

export interface FileBackupLogEventsRepo {
  append(runId: string, level: LogEventLevel, step: string, message: string): void;
  listRecent(opts?: ListLogEventsOptions): { events: LogEvent[]; total: number };
  listDistinctSteps(): string[];
}

/**
 * Deliberately its own table, not a shared one with logEventsRepo.ts's
 * log_events — see 0006_add_file_backup_log_events.sql for why. Same
 * shape/query patterns throughout (reuses LogEvent/LogEventLevel/
 * ListLogEventsOptions from the DB-backup domain since those types don't
 * encode anything backup_tasks-specific, just the row shape) so the Logs
 * screen can present both domains through one shared UI.
 */
export function createFileBackupLogEventsRepo(db: Database): FileBackupLogEventsRepo {
  const insertStmt = db.prepare(
    'INSERT INTO file_backup_log_events (run_id, level, step, message) VALUES (?, ?, ?, ?)'
  );

  const whereClause = `
    WHERE (@search IS NULL OR message LIKE '%' || @search || '%')
      AND (@step IS NULL OR step = @step)
      AND (@level IS NULL OR level = @level)
      AND (@from IS NULL OR created_at >= @from)
      AND (@to IS NULL OR created_at <= @to)
      AND (@clientId IS NULL OR run_id IN (SELECT id FROM file_backup_runs WHERE client_id = @clientId))
  `;
  const listStmt = db.prepare<Record<string, unknown>, FileBackupLogEventRow>(
    `SELECT * FROM file_backup_log_events ${whereClause} ORDER BY created_at DESC, id DESC LIMIT @limit OFFSET @offset`
  );
  const countStmt = db.prepare<Record<string, unknown>, { total: number }>(
    `SELECT COUNT(*) AS total FROM file_backup_log_events ${whereClause}`
  );
  const distinctStepsStmt = db.prepare<[], { step: string }>(
    `SELECT DISTINCT step FROM file_backup_log_events WHERE step IS NOT NULL ORDER BY step`
  );

  return {
    append(runId, level, step, message) {
      insertStmt.run(runId, level, step, message);
    },

    listRecent(opts) {
      const params = {
        search: opts?.search ?? null,
        step: opts?.step ?? null,
        level: opts?.level ?? null,
        from: opts?.from ?? null,
        to: opts?.to ?? null,
        clientId: opts?.clientId ?? null,
        limit: opts?.limit ?? 50,
        offset: opts?.offset ?? 0,
      };
      const events = listStmt.all(params).map(toDomain);
      const { total } = countStmt.get(params) ?? { total: 0 };
      return { events, total };
    },

    listDistinctSteps() {
      return distinctStepsStmt.all().map((row) => row.step);
    },
  };
}
