import type { Database } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { BackupSet } from '../../types.js';

interface BackupSetRow {
  id: string;
  client_id: string;
  name: string;
  is_active: number;
  created_at: string;
  updated_at: string;
}

function toDomain(row: BackupSetRow): BackupSet {
  return {
    id: row.id,
    clientId: row.client_id,
    name: row.name,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateBackupSetInput {
  clientId: string;
  name: string;
}

export interface UpdateBackupSetInput {
  name?: string;
}

export interface BackupSetsRepo {
  create(input: CreateBackupSetInput): BackupSet;
  update(id: string, patch: UpdateBackupSetInput): BackupSet;
  deactivate(id: string): void;
  reactivate(id: string): void;
  getById(id: string): BackupSet | null;
  listByClient(clientId: string, opts?: { includeInactive?: boolean }): BackupSet[];
}

function friendlyUniqueNameError(err: unknown, name: string): never {
  if (err instanceof Error && /UNIQUE constraint failed: backup_sets\.client_id, backup_sets\.name/.test(err.message)) {
    throw new Error(`A backup set named "${name}" already exists for this client.`);
  }
  throw err;
}

export function createBackupSetsRepo(db: Database): BackupSetsRepo {
  const insertStmt = db.prepare(`INSERT INTO backup_sets (id, client_id, name) VALUES (@id, @clientId, @name)`);
  const getByIdStmt = db.prepare<[string], BackupSetRow>('SELECT * FROM backup_sets WHERE id = ?');
  const listByClientStmt = db.prepare<[string], BackupSetRow>('SELECT * FROM backup_sets WHERE client_id = ? ORDER BY name');
  const listActiveByClientStmt = db.prepare<[string], BackupSetRow>(
    'SELECT * FROM backup_sets WHERE client_id = ? AND is_active = 1 ORDER BY name'
  );
  const updateStmt = db.prepare(
    `UPDATE backup_sets SET name = @name, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = @id`
  );
  const deactivateStmt = db.prepare(
    `UPDATE backup_sets SET is_active = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
  );
  const reactivateStmt = db.prepare(
    `UPDATE backup_sets SET is_active = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
  );

  return {
    create(input) {
      const id = randomUUID();
      try {
        insertStmt.run({ id, clientId: input.clientId, name: input.name });
      } catch (err) {
        friendlyUniqueNameError(err, input.name);
      }
      const row = getByIdStmt.get(id);
      if (!row) throw new Error(`Failed to read back created backup set ${id}`);
      return toDomain(row);
    },

    update(id, patch) {
      const current = getByIdStmt.get(id);
      if (!current) throw new Error(`Backup set ${id} not found.`);
      const name = patch.name ?? current.name;
      try {
        updateStmt.run({ id, name });
      } catch (err) {
        friendlyUniqueNameError(err, name);
      }
      const row = getByIdStmt.get(id);
      if (!row) throw new Error(`Failed to read back updated backup set ${id}`);
      return toDomain(row);
    },

    deactivate(id) {
      const current = getByIdStmt.get(id);
      if (!current) throw new Error(`Backup set ${id} not found.`);
      deactivateStmt.run(id);
    },

    reactivate(id) {
      const current = getByIdStmt.get(id);
      if (!current) throw new Error(`Backup set ${id} not found.`);
      reactivateStmt.run(id);
    },

    getById(id) {
      const row = getByIdStmt.get(id);
      return row ? toDomain(row) : null;
    },

    listByClient(clientId, opts) {
      const rows = opts?.includeInactive ? listByClientStmt.all(clientId) : listActiveByClientStmt.all(clientId);
      return rows.map(toDomain);
    },
  };
}
