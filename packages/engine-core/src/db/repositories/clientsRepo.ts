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

export interface ClientsRepo {
  create(input: CreateClientInput): Client;
  getById(id: string): Client | null;
  getByName(name: string): Client | null;
  listActive(): Client[];
}

export function createClientsRepo(db: Database): ClientsRepo {
  const insertStmt = db.prepare(
    `INSERT INTO clients (id, name, description, local_base_path, retention_count, retention_days)
     VALUES (@id, @name, @description, @localBasePath, @retentionCount, @retentionDays)`
  );
  const getByIdStmt = db.prepare<[string], ClientRow>('SELECT * FROM clients WHERE id = ?');
  const getByNameStmt = db.prepare<[string], ClientRow>('SELECT * FROM clients WHERE name = ?');
  const listActiveStmt = db.prepare<[], ClientRow>('SELECT * FROM clients WHERE is_active = 1 ORDER BY name');

  return {
    create(input) {
      const id = randomUUID();
      insertStmt.run({
        id,
        name: input.name,
        description: input.description ?? null,
        localBasePath: input.localBasePath,
        retentionCount: input.retentionCount ?? null,
        retentionDays: input.retentionDays ?? null,
      });
      const row = getByIdStmt.get(id);
      if (!row) throw new Error(`Failed to read back created client ${id}`);
      return toDomain(row);
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
