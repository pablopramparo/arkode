import type { Database } from 'better-sqlite3';

export interface SettingsRepo {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export function createSettingsRepo(db: Database): SettingsRepo {
  const getStmt = db.prepare<[string], { value: string }>('SELECT value FROM app_settings WHERE key = ?');
  const upsertStmt = db.prepare(
    `INSERT INTO app_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  );

  return {
    get(key) {
      return getStmt.get(key)?.value ?? null;
    },
    set(key, value) {
      upsertStmt.run(key, value);
    },
  };
}
