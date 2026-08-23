import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { dbFilePath } from '../paths.js';

let db: Database.Database | undefined;

/**
 * Opens (or returns the already-open) singleton SQLite connection for this
 * process. WAL + busy_timeout matter here specifically because the GUI and a
 * Task-Scheduler-invoked engine process can be writing at overlapping times —
 * WAL allows concurrent readers but still serializes writers, and
 * busy_timeout lets a writer wait instead of failing immediately.
 */
export function getDb(filePath: string = dbFilePath()): Database.Database {
  if (db) return db;

  mkdirSync(dirname(filePath), { recursive: true });
  db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  return db;
}

export function closeDb(): void {
  db?.close();
  db = undefined;
}
