import type { Database } from 'better-sqlite3';

export type LogEventLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEvent {
  id: number;
  runId: string | null;
  level: LogEventLevel;
  step: string | null;
  message: string;
  createdAt: string;
}

interface LogEventRow {
  id: number;
  run_id: string | null;
  level: string;
  step: string | null;
  message: string;
  created_at: string;
}

function toDomain(row: LogEventRow): LogEvent {
  return {
    id: row.id,
    runId: row.run_id,
    level: row.level as LogEventLevel,
    step: row.step,
    message: row.message,
    createdAt: row.created_at,
  };
}

export interface ListLogEventsOptions {
  /** Case-insensitive substring match against the message. */
  search?: string;
  step?: string;
  level?: LogEventLevel;
  /** Inclusive ISO-8601 bounds on created_at. */
  from?: string;
  to?: string;
  /** Restrict to events whose run belongs to this client (resolved via the run row). */
  clientId?: string;
  /** Default 50. */
  limit?: number;
  /** Default 0. */
  offset?: number;
}

export interface LogEventsRepo {
  append(runId: string, level: LogEventLevel, step: string, message: string): void;
  /** Newest first, paginated — for the UI's Logs screen. `total` reflects the filters but not the page, for building pagination controls. */
  listRecent(opts?: ListLogEventsOptions): { events: LogEvent[]; total: number };
  /** Every distinct `step` value ever logged — powers the Logs screen's "acción" filter dropdown without hardcoding the pipeline's step names here. */
  listDistinctSteps(): string[];
}

export function createLogEventsRepo(db: Database): LogEventsRepo {
  const insertStmt = db.prepare(
    'INSERT INTO log_events (run_id, level, step, message) VALUES (?, ?, ?, ?)'
  );

  const whereClause = `
    WHERE (@search IS NULL OR message LIKE '%' || @search || '%')
      AND (@step IS NULL OR step = @step)
      AND (@level IS NULL OR level = @level)
      AND (@from IS NULL OR created_at >= @from)
      AND (@to IS NULL OR created_at <= @to)
      AND (@clientId IS NULL OR run_id IN (SELECT id FROM backup_runs WHERE client_id = @clientId))
  `;
  const listStmt = db.prepare<Record<string, unknown>, LogEventRow>(
    `SELECT * FROM log_events ${whereClause} ORDER BY created_at DESC, id DESC LIMIT @limit OFFSET @offset`
  );
  const countStmt = db.prepare<Record<string, unknown>, { total: number }>(
    `SELECT COUNT(*) AS total FROM log_events ${whereClause}`
  );
  const distinctStepsStmt = db.prepare<[], { step: string }>(
    `SELECT DISTINCT step FROM log_events WHERE step IS NOT NULL ORDER BY step`
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
