import type { Database } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { VaultUrl } from '../../vault/types.js';

interface VaultUrlRow {
  id: string;
  client_id: string;
  name: string;
  url: string;
  environment: string | null;
  tags: string;
  linked_credential_id: string | null;
  favorite: number;
  description: string | null;
  created_at: string;
  updated_at: string;
}

function toDomain(row: VaultUrlRow): VaultUrl {
  let tags: string[] = [];
  try {
    const p = JSON.parse(row.tags) as unknown;
    if (Array.isArray(p)) tags = p.filter((t): t is string => typeof t === 'string');
  } catch {
    /* empty */
  }
  return {
    id: row.id,
    clientId: row.client_id,
    name: row.name,
    url: row.url,
    environment: row.environment,
    tags,
    linkedCredentialId: row.linked_credential_id,
    favorite: row.favorite === 1,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateVaultUrlInput {
  clientId: string;
  name: string;
  url: string;
  environment?: string | null;
  tags?: string[];
  linkedCredentialId?: string | null;
  favorite?: boolean;
  description?: string | null;
}

export interface UpdateVaultUrlInput {
  name?: string;
  url?: string;
  environment?: string | null;
  tags?: string[];
  linkedCredentialId?: string | null;
  favorite?: boolean;
  description?: string | null;
}

export interface VaultUrlsRepo {
  create(input: CreateVaultUrlInput): VaultUrl;
  update(id: string, patch: UpdateVaultUrlInput): VaultUrl;
  delete(id: string): void;
  getById(id: string): VaultUrl | null;
  listByClient(clientId: string): VaultUrl[];
  listAll(): VaultUrl[];
  search(tokens: string[], clientId?: string): VaultUrl[];
}

const SEARCH_COLUMNS = ['name', 'url', 'environment', 'tags', 'description'];

export function createVaultUrlsRepo(db: Database): VaultUrlsRepo {
  const insertStmt = db.prepare(
    `INSERT INTO vault_urls (id, client_id, name, url, environment, tags, linked_credential_id, favorite, description)
     VALUES (@id, @clientId, @name, @url, @environment, @tags, @linkedCredentialId, @favorite, @description)`
  );
  const getByIdStmt = db.prepare<[string], VaultUrlRow>('SELECT * FROM vault_urls WHERE id = ?');
  const listByClientStmt = db.prepare<[string], VaultUrlRow>(
    'SELECT * FROM vault_urls WHERE client_id = ? ORDER BY favorite DESC, name'
  );
  const listAllStmt = db.prepare<[], VaultUrlRow>('SELECT * FROM vault_urls ORDER BY favorite DESC, name');
  const deleteStmt = db.prepare('DELETE FROM vault_urls WHERE id = ?');

  return {
    create(input) {
      const id = randomUUID();
      insertStmt.run({
        id,
        clientId: input.clientId,
        name: input.name,
        url: input.url,
        environment: input.environment ?? null,
        tags: JSON.stringify(input.tags ?? []),
        linkedCredentialId: input.linkedCredentialId ?? null,
        favorite: input.favorite ? 1 : 0,
        description: input.description ?? null,
      });
      return toDomain(getByIdStmt.get(id)!);
    },
    update(id, patch) {
      const current = getByIdStmt.get(id);
      if (!current) throw new Error(`Vault URL ${id} not found.`);
      const sets: string[] = [];
      const params: Record<string, unknown> = { id };
      const put = (col: string, key: string, v: unknown) => {
        sets.push(`${col} = @${key}`);
        params[key] = v;
      };
      if (patch.name !== undefined) put('name', 'name', patch.name);
      if (patch.url !== undefined) put('url', 'url', patch.url);
      if (patch.environment !== undefined) put('environment', 'environment', patch.environment);
      if (patch.tags !== undefined) put('tags', 'tags', JSON.stringify(patch.tags));
      if (patch.linkedCredentialId !== undefined) put('linked_credential_id', 'linkedCredentialId', patch.linkedCredentialId);
      if (patch.favorite !== undefined) put('favorite', 'favorite', patch.favorite ? 1 : 0);
      if (patch.description !== undefined) put('description', 'description', patch.description);
      if (sets.length > 0) {
        sets.push(`updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`);
        db.prepare(`UPDATE vault_urls SET ${sets.join(', ')} WHERE id = @id`).run(params);
      }
      return toDomain(getByIdStmt.get(id)!);
    },
    delete(id) {
      const current = getByIdStmt.get(id);
      if (!current) throw new Error(`Vault URL ${id} not found.`);
      deleteStmt.run(id);
    },
    getById(id) {
      const row = getByIdStmt.get(id);
      return row ? toDomain(row) : null;
    },
    listByClient(clientId) {
      return listByClientStmt.all(clientId).map(toDomain);
    },
    listAll() {
      return listAllStmt.all().map(toDomain);
    },
    search(tokens, clientId) {
      const clean = tokens.map((t) => t.trim()).filter(Boolean);
      if (clean.length === 0) return clientId ? this.listByClient(clientId) : this.listAll();
      const where: string[] = [];
      const params: unknown[] = [];
      for (const token of clean) {
        where.push(`(${SEARCH_COLUMNS.map((c) => `${c} LIKE ?`).join(' OR ')})`);
        for (let i = 0; i < SEARCH_COLUMNS.length; i++) params.push(`%${token}%`);
      }
      let sql = `SELECT * FROM vault_urls WHERE ${where.join(' AND ')}`;
      if (clientId) {
        sql += ' AND client_id = ?';
        params.push(clientId);
      }
      sql += ' ORDER BY favorite DESC, name';
      return db.prepare<unknown[], VaultUrlRow>(sql).all(...params).map(toDomain);
    },
  };
}
