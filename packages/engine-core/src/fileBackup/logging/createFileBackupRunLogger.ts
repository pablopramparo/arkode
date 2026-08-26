import pino from 'pino';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { logsDir } from '../../paths.js';
import type { FileBackupLogEventsRepo } from '../db/repositories/fileBackupLogEventsRepo.js';

export interface FileBackupRunLogger {
  readonly filePath: string;
  log(level: 'debug' | 'info' | 'warn' | 'error', step: string, message: string, extra?: Record<string, unknown>): void;
}

/**
 * Every step writes to both: a pino JSON-lines file (same convention as
 * logging/logger.ts's createRunLogger for the DB-backup domain) and
 * file_backup_log_events — its own table, not log_events, because
 * log_events.run_id has a real foreign key to backup_runs(id) specifically
 * (confirmed the hard way: inserting a file_backup_runs id there throws
 * "FOREIGN KEY constraint failed"). See 0006_add_file_backup_log_events.sql.
 */
export function createFileBackupRunLogger(
  runId: string,
  logEvents: FileBackupLogEventsRepo,
  dir: string = logsDir()
): FileBackupRunLogger {
  mkdirSync(dir, { recursive: true });
  const dateStamp = new Date().toISOString().slice(0, 10);
  const filePath = join(dir, `${dateStamp}.log`);
  const fileLogger = pino(pino.destination({ dest: filePath, append: true })).child({ runId, domain: 'file-backup' });

  return {
    filePath,
    log(level, step, message, extra) {
      fileLogger[level]({ step, ...extra }, message);
      logEvents.append(runId, level, step, message);
    },
  };
}
