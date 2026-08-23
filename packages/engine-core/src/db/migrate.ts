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
    const applyMigration = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(file);
    });
    applyMigration();
  }
}
