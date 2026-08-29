import pino from 'pino';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { logsDir } from '../../paths.js';
import type { FileBackupLogEventsRepo } from '../db/repositories/fileBackupLogEventsRepo.js';

export interface FileBackupRunLogger {
  readonly filePath: string;
  log(level: 'debug' | 'info' | 'warn' | 'error', step: string, message: string, extra?: Record<string, unknown>): void;
}

/** See logging/logger.ts's tryOpenFileLogger — same rationale (sync open so an EACCES throws here, not as a later flushSync(-1) crash). */
function tryOpenFileLogger(filePath: string, bindings: Record<string, unknown>): pino.Logger | null {
  try {
    const dest = pino.destination({ dest: filePath, append: true, sync: true });
    dest.on('error', () => {});
    return pino(dest).child(bindings);
  } catch {
    return null;
  }
}

/**
 * Every step writes to both: a pino JSON-lines file (same convention as
 * logging/logger.ts's createRunLogger for the DB-backup domain) and
 * file_backup_log_events — its own table, not log_events, because
 * log_events.run_id has a real foreign key to backup_runs(id) specifically
 * (confirmed the hard way: inserting a file_backup_runs id there throws
 * "FOREIGN KEY constraint failed"). See 0006_add_file_backup_log_events.sql.
 *
 * File logging is best-effort with a per-run fallback — see createRunLogger's
 * own doc comment for why (a SYSTEM Task-Scheduler run can leave the daily
 * file un-writable for the user-run app's sidecar).
 */
export function createFileBackupRunLogger(
  runId: string,
  logEvents: FileBackupLogEventsRepo,
  dir: string = logsDir()
): FileBackupRunLogger {
  let fileLogger: pino.Logger | null = null;
  let filePath = '';
  try {
    mkdirSync(dir, { recursive: true });
    const dateStamp = new Date().toISOString().slice(0, 10);
    const bindings = { runId, domain: 'file-backup' };
    filePath = join(dir, `${dateStamp}.log`);
    fileLogger = tryOpenFileLogger(filePath, bindings);
    if (!fileLogger) {
      filePath = join(dir, `${dateStamp}-${runId.slice(0, 8)}.log`);
      fileLogger = tryOpenFileLogger(filePath, bindings);
    }
    if (!fileLogger) filePath = '';
  } catch {
    fileLogger = null;
    filePath = '';
  }

  return {
    filePath,
    log(level, step, message, extra) {
      try {
        fileLogger?.[level]({ step, ...extra }, message);
      } catch {
        /* best-effort */
      }
      logEvents.append(runId, level, step, message);
    },
  };
}
