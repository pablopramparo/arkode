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
 * Opens a pino file logger at `filePath`, or returns null if the file can't
 * be opened. `sync: true` makes an open failure (e.g. EACCES) throw
 * synchronously here instead of surfacing as an async 'error' event or a
 * later `flushSync(-1)` crash ("The value of 'fd' is out of range …
 * Received -1"). The `'error'` listener catches a *later* write failure
 * (disk full, etc.) the same way.
 */
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
 * Every step writes to both: a pino JSON-lines file (one file per day, so
 * diagnosis is possible even if SQLite itself is having problems) and the
 * log_events table (condensed, queryable rows for the UI's Logs screen).
 *
 * File logging is strictly best-effort: the daily file can be un-writable
 * for the current process (a Task-Scheduler run executes as SYSTEM and
 * creates `<date>.log` owned by SYSTEM with Users-read-only ACLs; the
 * user-launched app's sidecar then can't append to it). On that failure we
 * fall back to a per-run file this process can definitely create, and if
 * even that fails we log to SQLite only — a run must never die because a
 * log file couldn't be opened.
 */
export function createRunLogger(runId: string, logEvents: LogEventsRepo, dir: string = logsDir()): RunLogger {
  let fileLogger: pino.Logger | null = null;
  let filePath = '';
  try {
    mkdirSync(dir, { recursive: true });
    const dateStamp = new Date().toISOString().slice(0, 10);
    const bindings = { runId };
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
        /* best-effort — never let file logging break a run */
      }
      logEvents.append(runId, level, step, message);
    },
  };
}
