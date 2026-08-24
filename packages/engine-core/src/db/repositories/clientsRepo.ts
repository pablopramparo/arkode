import type { Database } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { Client } from '../../types.js';

interface ClientRow {
  id: string;
  name: string;
  description: string | null;
  is_active: number;
  local_base_path: string;
  retention_count: number | null;
  retention_days: number | null;
  created_at: string;
  updated_at: string;
}

function toDomain(row: ClientRow): Client {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    isActive: row.is_active === 1,
    localBasePath: row.local_base_path,
    retentionCount: row.retention_count,
    retentionDays: row.retention_days,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateClientInput {
  name: string;
  description?: string | null;
  localBasePath: string;
  retentionCount?: number | null;
  retentionDays?: number | null;
}

export interface UpdateClientInput {
  name?: string;
  description?: string | null;
  localBasePath?: string;
  retentionCount?: number | null;
  retentionDays?: number | null;
}

export interface ClientsRepo {
  create(input: CreateClientInput): Client;
  update(id: string, patch: UpdateClientInput): Client;
  deactivate(id: string): void;
  getById(id: string): Client | null;
  getByName(name: string): Client | null;
  listActive(): Client[];
}

function friendlyUniqueNameError(err: unknown, name: string): never {
  if (err instanceof Error && /UNIQUE constraint failed: clients\.name/.test(err.message)) {
    throw new Error(`A client named "${name}" already exists.`);
  }
  throw err;
}

export function createClientsRepo(db: Database): ClientsRepo {
  const insertStmt = db.prepare(
    `INSERT INTO clients (id, name, description, local_base_path, retention_count, retention_days)
     VALUES (@id, @name, @description, @localBasePath, @retentionCount, @retentionDays)`
  );
  const getByIdStmt = db.prepare<[string], ClientRow>('SELECT * FROM clients WHERE id = ?');
  const getByNameStmt = db.prepare<[string], ClientRow>('SELECT * FROM clients WHERE name = ?');
  const listActiveStmt = db.prepare<[], ClientRow>('SELECT * FROM clients WHERE is_active = 1 ORDER BY name');
  const updateStmt = db.prepare(
    `UPDATE clients
     SET name = @name, description = @description, local_base_path = @localBasePath,
         retention_count = @retentionCount, retention_days = @retentionDays,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = @id`
  );
  const deactivateStmt = db.prepare(
    `UPDATE clients SET is_active = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
  );

  return {
    create(input) {
      const id = randomUUID();
      try {
        insertStmt.run({
          id,
          name: input.name,
          description: input.description ?? null,
          localBasePath: input.localBasePath,
          retentionCount: input.retentionCount ?? null,
          retentionDays: input.retentionDays ?? null,
        });
      } catch (err) {
        friendlyUniqueNameError(err, input.name);
      }
      const row = getByIdStmt.get(id);
      if (!row) throw new Error(`Failed to read back created client ${id}`);
      return toDomain(row);
    },

    update(id, patch) {
      const current = getByIdStmt.get(id);
      if (!current) throw new Error(`Client ${id} not found.`);
      const name = patch.name ?? current.name;
      try {
        updateStmt.run({
          id,
          name,
          description: patch.description !== undefined ? patch.description : current.description,
          localBasePath: patch.localBasePath ?? current.local_base_path,
          retentionCount: patch.retentionCount !== undefined ? patch.retentionCount : current.retention_count,
          retentionDays: patch.retentionDays !== undefined ? patch.retentionDays : current.retention_days,
        });
      } catch (err) {
        friendlyUniqueNameError(err, name);
      }
      const row = getByIdStmt.get(id);
      if (!row) throw new Error(`Failed to read back updated client ${id}`);
      return toDomain(row);
    },

    deactivate(id) {
      const current = getByIdStmt.get(id);
      if (!current) throw new Error(`Client ${id} not found.`);
      deactivateStmt.run(id);
    },

    getById(id) {
      const row = getByIdStmt.get(id);
      return row ? toDomain(row) : null;
    },

    getByName(name) {
      const row = getByNameStmt.get(name);
      return row ? toDomain(row) : null;
    },

    listActive() {
      return listActiveStmt.all().map(toDomain);
    },
  };
}
