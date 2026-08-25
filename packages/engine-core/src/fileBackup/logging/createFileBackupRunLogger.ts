import pino from 'pino';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { logsDir } from '../../paths.js';

export interface FileBackupRunLogger {
  readonly filePath: string;
  log(level: 'debug' | 'info' | 'warn' | 'error', step: string, message: string, extra?: Record<string, unknown>): void;
}

/**
 * File-only logger for file-backup runs — deliberately does NOT also write
 * to the log_events table the way logging/logger.ts's createRunLogger does
 * for DB-backup runs. Found the hard way, against a real repository:
 * log_events.run_id has an actual foreign key to backup_runs(id)
 * specifically (see db/migrations/0001_init.sql) — inserting a
 * file_backup_runs id there throws "FOREIGN KEY constraint failed", not a
 * silent no-op. Every warning/error a file-backup run produces is already
 * captured queryably in file_backup_runs.warnings/error_message; a
 * dedicated file_backup_log_events table mirroring log_events would be a
 * reasonable later addition if the Logs screen ever needs step-by-step
 * detail for file backups too — not needed for this first increment, and
 * out of scope per "sin cambios de schema" beyond what this increment
 * already requires.
 */
export function createFileBackupRunLogger(runId: string, dir: string = logsDir()): FileBackupRunLogger {
  mkdirSync(dir, { recursive: true });
  const dateStamp = new Date().toISOString().slice(0, 10);
  const filePath = join(dir, `${dateStamp}.log`);
  const fileLogger = pino(pino.destination({ dest: filePath, append: true })).child({ runId, domain: 'file-backup' });

  return {
    filePath,
    log(level, step, message, extra) {
      fileLogger[level]({ step, ...extra }, message);
    },
  };
}
