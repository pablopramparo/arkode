import type { Database } from 'better-sqlite3';

export type LogEventLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEventsRepo {
  append(runId: string, level: LogEventLevel, step: string, message: string): void;
}

export function createLogEventsRepo(db: Database): LogEventsRepo {
  const insertStmt = db.prepare(
    'INSERT INTO log_events (run_id, level, step, message) VALUES (?, ?, ?, ?)'
  );

  return {
    append(runId, level, step, message) {
      insertStmt.run(runId, level, step, message);
    },
  };
}
