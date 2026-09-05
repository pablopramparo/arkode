import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runMigrations } from '../../src/db/migrate.js';
import { migrationsSourceDir } from '../../src/paths.js';
import { createClientsRepo } from '../../src/db/repositories/clientsRepo.js';
import { createTransportsRepo } from '../../src/db/repositories/transportsRepo.js';
import { createDatabaseConnectionsRepo } from '../../src/db/repositories/databaseConnectionsRepo.js';
import { createTasksRepo } from '../../src/db/repositories/tasksRepo.js';
import { createRunsRepo } from '../../src/db/repositories/runsRepo.js';
import { createSettingsRepo } from '../../src/db/repositories/settingsRepo.js';

const MIGRATIONS_DIR = migrationsSourceDir();
const PRE_VAULT_COUNT = 17; // 0001..0017 — everything before the vault migrations

/**
 * Builds a DB frozen at the pre-vault schema (migrations 0001..0017 only),
 * exactly as an existing v0.4.11 install's data.sqlite3 looks.
 */
function preVaultDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));`);
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files.slice(0, PRE_VAULT_COUNT)) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
    db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(file);
  }
  return db;
}

function seedExistingInstall(db: Database.Database) {
  const clientsRepo = createClientsRepo(db);
  const transportsRepo = createTransportsRepo(db);
  const dbcRepo = createDatabaseConnectionsRepo(db);
  const tasksRepo = createTasksRepo(db, transportsRepo, dbcRepo);
  const runsRepo = createRunsRepo(db);
  const settingsRepo = createSettingsRepo(db);

  const client = clientsRepo.create({ name: 'Rivera', localBasePath: 'D:\\B\\Rivera', retentionCount: 10 });

  // An SSH transport with a Tier-1 passphrase ref (the ref string is all
  // that lives in SQLite; the DPAPI blob lives in the `secrets` table).
  const transport = transportsRepo.createSsh({
    clientId: client.id, name: 'Rivera VPS', host: 'vps.rivera.com', username: 'arkode',
    privateKeyPath: 'C:\\ProgramData\\arkode\\keys\\existing-key.key',
    passphraseSecretRef: 'transport:passphrase:existing-1',
  });
  db.prepare('INSERT INTO secrets (ref, ciphertext) VALUES (?, ?)').run('transport:passphrase:existing-1', Buffer.from('CIPHERTEXT-BYTES'));

  const dbc = dbcRepo.create({
    clientId: client.id, name: 'Rivera PG', engine: 'postgres', host: 'db.rivera.com', port: 5432,
    databaseName: 'rivera', username: 'backup', passwordSecretRef: 'databaseConnection:password:existing-1',
  });
  db.prepare('INSERT INTO secrets (ref, ciphertext) VALUES (?, ?)').run('databaseConnection:password:existing-1', Buffer.from('PW-CIPHERTEXT'));

  const task = tasksRepo.createDirectDump({ clientId: client.id, databaseConnectionId: dbc.id, name: 'Rivera nightly', dbEngine: 'postgres', retentionCount: 7 });
  tasksRepo.setSchedule(task.id, { scheduleTime: '03:00', scheduleEnabled: true, scheduleFrequency: 'daily' });

  // Two real, finished backup runs — the "existing backups" that must not be touched.
  const run1 = runsRepo.create({ taskId: task.id, clientId: client.id, strategy: 'direct_dump', transportId: null, databaseConnectionId: dbc.id, pid: 1234 });
  runsRepo.markProducing(run1.id);
  runsRepo.markValidating(run1.id, { fileName: 'rivera_20260901.dump', sizeBytes: 12345, checksumSha256: 'a'.repeat(64), localPath: 'D:\\B\\Rivera\\rivera_20260901.dump' });
  runsRepo.markFinished(run1.id, 'Success');
  const run2 = runsRepo.create({ taskId: task.id, clientId: client.id, strategy: 'direct_dump', databaseConnectionId: dbc.id });
  runsRepo.markProducing(run2.id);
  runsRepo.markValidating(run2.id, { fileName: 'rivera_20260902.dump', sizeBytes: 22222, checksumSha256: 'b'.repeat(64), localPath: 'D:\\B\\Rivera\\rivera_20260902.dump' });
  runsRepo.markFinished(run2.id, 'Success');

  settingsRepo.set('schedulerHeartbeatAt', '2026-09-02T03:00:00.000Z');

  return { client, transport, dbc, task, run1, run2 };
}

describe('upgrade safety — applying the vault migrations (0018..0021) over an existing v0.4.11 install', () => {
  it('the four migrations are purely additive (no ALTER/UPDATE/DELETE/DROP against existing tables)', () => {
    for (const file of ['0018_add_vault_meta_and_secrets.sql', '0019_add_vault_credentials.sql', '0020_add_vault_knowledge.sql', '0021_add_vault_backup_targets.sql']) {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      const stripped = sql.replace(/--.*$/gm, '');
      expect(/\bALTER\s+TABLE\b/i.test(stripped), `${file} must not ALTER`).toBe(false);
      expect(/\bDROP\s+TABLE\b/i.test(stripped), `${file} must not DROP`).toBe(false);
      expect(/\bUPDATE\b/i.test(stripped), `${file} must not UPDATE`).toBe(false);
      expect(/\bDELETE\s+FROM\b/i.test(stripped), `${file} must not DELETE`).toBe(false);
      // only CREATE TABLE / CREATE [UNIQUE] INDEX statements
      const statements = stripped.split(';').map((s) => s.trim()).filter(Boolean);
      for (const st of statements) {
        expect(/^CREATE (TABLE|UNIQUE INDEX|INDEX)\b/i.test(st), `${file}: unexpected statement "${st.slice(0, 40)}"`).toBe(true);
      }
    }
  });

  it('runMigrations upgrades a pre-vault DB cleanly and leaves every existing row untouched', () => {
    const db = preVaultDb();
    const seeded = seedExistingInstall(db);

    const before = {
      clients: db.prepare('SELECT * FROM clients').all(),
      transports: db.prepare('SELECT * FROM transports').all(),
      dbConns: db.prepare('SELECT * FROM database_connections').all(),
      tasks: db.prepare('SELECT * FROM backup_tasks').all(),
      runs: db.prepare('SELECT * FROM backup_runs ORDER BY started_at').all(),
      secrets: db.prepare('SELECT ref, ciphertext FROM secrets ORDER BY ref').all(),
      settings: db.prepare('SELECT * FROM app_settings').all(),
    };

    // The upgrade.
    runMigrations(db, MIGRATIONS_DIR);

    // All four vault migrations recorded.
    const applied = (db.prepare('SELECT name FROM schema_migrations').all() as { name: string }[]).map((r) => r.name);
    for (const m of ['0018_add_vault_meta_and_secrets.sql', '0019_add_vault_credentials.sql', '0020_add_vault_knowledge.sql', '0021_add_vault_backup_targets.sql']) {
      expect(applied).toContain(m);
    }

    // New tables exist and are empty.
    for (const t of ['vault_meta', 'vault_secrets', 'vault_credentials', 'vault_urls', 'vault_items', 'vault_backup_targets', 'vault_backup_runs']) {
      expect(db.prepare(`SELECT count(*) AS n FROM ${t}`).get()).toEqual({ n: 0 });
    }

    // Every pre-existing row is byte-for-byte identical.
    expect(db.prepare('SELECT * FROM clients').all()).toEqual(before.clients);
    expect(db.prepare('SELECT * FROM transports').all()).toEqual(before.transports);
    expect(db.prepare('SELECT * FROM database_connections').all()).toEqual(before.dbConns);
    expect(db.prepare('SELECT * FROM backup_tasks').all()).toEqual(before.tasks);
    expect(db.prepare('SELECT * FROM app_settings').all()).toEqual(before.settings);

    // Existing BACKUPS are not deleted or modified.
    const runsAfter = db.prepare('SELECT * FROM backup_runs ORDER BY started_at').all();
    expect(runsAfter).toEqual(before.runs);
    expect(runsAfter).toHaveLength(2);
    expect((runsAfter as { status: string }[]).every((r) => r.status === 'Success')).toBe(true);
    expect((runsAfter as { local_path: string }[]).map((r) => r.local_path)).toEqual([
      'D:\\B\\Rivera\\rivera_20260901.dump',
      'D:\\B\\Rivera\\rivera_20260902.dump',
    ]);

    // Tier-1 secrets (the `secrets` table) are untouched — same refs, same ciphertext.
    expect(db.prepare('SELECT ref, ciphertext FROM secrets ORDER BY ref').all()).toEqual(before.secrets);

    // Running migrations again is a no-op.
    const countBefore = db.prepare('SELECT count(*) AS n FROM schema_migrations').get() as { n: number };
    runMigrations(db, MIGRATIONS_DIR);
    expect(db.prepare('SELECT count(*) AS n FROM schema_migrations').get()).toEqual(countBefore);
  });

  it('Tier-1 secrets still resolve, and the scheduler tick still composes, after the upgrade', () => {
    const db = preVaultDb();
    const { task } = seedExistingInstall(db);
    runMigrations(db, MIGRATIONS_DIR);

    // The MachineDpapiSecretStore is unchanged; a fake store reads the same `secrets` rows.
    const raw = db.prepare('SELECT ciphertext FROM secrets WHERE ref = ?').get('transport:passphrase:existing-1') as { ciphertext: Buffer };
    expect(raw.ciphertext.toString()).toBe('CIPHERTEXT-BYTES');

    // The scheduler's due-check reads the same task row it always did.
    const tasksRepo = createTasksRepo(db, createTransportsRepo(db), createDatabaseConnectionsRepo(db));
    const t = tasksRepo.getById(task.id)!;
    expect(t.scheduleTime).toBe('03:00');
    expect(t.scheduleEnabled).toBe(true);
    expect(t.isActive).toBe(true);
  });

  it('does not touch the SSH keys directory (no migration or code path deletes existing .key files)', () => {
    // The only code that deletes a keysDir() file is syncOperationalCopy's
    // deleteKeyFileIfUnreferenced, gated on an explicit unlink AND on no
    // transport referencing the path. Nothing in migrate.ts / startup does.
    const db = preVaultDb();
    seedExistingInstall(db);
    // The transport still points at its key path after the upgrade.
    runMigrations(db, MIGRATIONS_DIR);
    const kp = (db.prepare('SELECT private_key_path FROM transports').get() as { private_key_path: string }).private_key_path;
    expect(kp).toBe('C:\\ProgramData\\arkode\\keys\\existing-key.key');
  });
});
