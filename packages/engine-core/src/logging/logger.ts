import pino from 'pino';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { logsDir } from '../paths.js';
import type { LogEventsRepo, LogEventLevel } from '../db/repositories/logEventsRepo.js';

export interface RunLogger {
  readonly filePath: string;
  log(level: LogEventLevel, step: string, message: string, extra?: Record<string, unknown>): void;
}

/**
 * Every step writes to both: a pino JSON-lines file (one file per day, so
 * diagnosis is possible even if SQLite itself is having problems) and the
 * log_events table (condensed, queryable rows for the UI's Logs screen).
 */
export function createRunLogger(runId: string, logEvents: LogEventsRepo, dir: string = logsDir()): RunLogger {
  mkdirSync(dir, { recursive: true });
  const dateStamp = new Date().toISOString().slice(0, 10);
  const filePath = join(dir, `${dateStamp}.log`);
  const fileLogger = pino(pino.destination({ dest: filePath, append: true })).child({ runId });

  return {
    filePath,
    log(level, step, message, extra) {
      fileLogger[level]({ step, ...extra }, message);
      logEvents.append(runId, level, step, message);
    },
  };
}
