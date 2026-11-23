import type { Database } from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { migrationsSourceDir } from '../paths.js';

/**
 * Applies every .sql file under migrationsDir whose name isn't already
 * recorded in schema_migrations, in filename order (hence the numeric
 * prefixes like 0001_init.sql). Each migration runs in its own transaction
 * so a failure partway through one file doesn't leave it half-applied.
 */
export function runMigrations(db: Database, migrationsDir: string = migrationsSourceDir()): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);

  const rows = db.prepare('SELECT name FROM schema_migrations').all() as Array<{ name: string }>;
  const applied = new Set(rows.map((row) => row.name));

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = readFileSync(join(migrationsDir, file), 'utf8');

    // Table-rebuild migrations (the 12-step procedure) start with
    // `PRAGMA foreign_keys=OFF`, but SQLite ignores that pragma inside a
    // transaction — and every migration runs in one. With enforcement still
    // ON, `DROP TABLE <parent>` does an implicit DELETE that fires ON DELETE
    // CASCADE on child tables, silently wiping e.g. every backup_runs row when
    // backup_tasks is rebuilt. So for those files, switch enforcement off
    // here, OUTSIDE the transaction, and restore it afterwards, verifying
    // integrity before committing.
    const rebuildsTables = /PRAGMA\s+foreign_keys\s*=\s*OFF/i.test(sql);
    const fkWasOn = rebuildsTables && Number(db.pragma('foreign_keys', { simple: true })) === 1;
    if (fkWasOn) db.pragma('foreign_keys = OFF');
    try {
      const applyMigration = db.transaction(() => {
        db.exec(sql);
        if (fkWasOn) {
          const violations = db.pragma('foreign_key_check') as unknown[];
          if (violations.length > 0) {
            throw new Error(`Migration ${file} left ${violations.length} foreign-key violation(s); rolled back.`);
          }
        }
        db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(file);
      });
      applyMigration();
    } finally {
      if (fkWasOn) db.pragma('foreign_keys = ON');
    }
  }
}
