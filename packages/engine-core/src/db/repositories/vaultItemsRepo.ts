import type { Database } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { VaultItem, VaultItemMetadata, VaultItemType } from '../../vault/types.js';

interface VaultItemRow {
  id: string;
  client_id: string;
  type: string;
  title: string;
  environment: string | null;
  tags: string;
  description: string | null;
  favorite: number;
  is_sensitive: number;
  body_plaintext: string | null;
  body_blob_ref: string | null;
  metadata: string;
  created_at: string;
  updated_at: string;
}

function toDomain(row: VaultItemRow): VaultItem {
  let tags: string[] = [];
  try {
    const p = JSON.parse(row.tags) as unknown;
    if (Array.isArray(p)) tags = p.filter((t): t is string => typeof t === 'string');
  } catch {
    /* empty */
  }
  let metadata: VaultItemMetadata = {};
  try {
    const p = JSON.parse(row.metadata) as unknown;
    if (p && typeof p === 'object' && !Array.isArray(p)) metadata = p as VaultItemMetadata;
  } catch {
    /* empty */
  }
  return {
    id: row.id,
    clientId: row.client_id,
    type: row.type as VaultItemType,
    title: row.title,
    environment: row.environment,
    tags,
    description: row.description,
    favorite: row.favorite === 1,
    isSensitive: row.is_sensitive === 1,
    bodyPlaintext: row.body_plaintext,
    bodyBlobRef: row.body_blob_ref,
    metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateVaultItemInput {
  clientId: string;
  type: VaultItemType;
  title: string;
  environment?: string | null;
  tags?: string[];
  description?: string | null;
  favorite?: boolean;
  isSensitive?: boolean;
  bodyPlaintext?: string | null;
  bodyBlobRef?: string | null;
  metadata?: VaultItemMetadata;
}

export interface UpdateVaultItemInput {
  title?: string;
  environment?: string | null;
  tags?: string[];
  description?: string | null;
  favorite?: boolean;
  isSensitive?: boolean;
  bodyPlaintext?: string | null;
  bodyBlobRef?: string | null;
  metadata?: VaultItemMetadata;
}

export interface VaultItemsRepo {
  create(input: CreateVaultItemInput): VaultItem;
  update(id: string, patch: UpdateVaultItemInput): VaultItem;
  delete(id: string): { bodyBlobRef: string | null };
  getById(id: string): VaultItem | null;
  listByClient(clientId: string, type?: VaultItemType): VaultItem[];
  listAll(): VaultItem[];
  setBodyBlobRef(id: string, ref: string | null): void;
  /** Metadata-only scan; `body_plaintext` is included ONLY for non-sensitive rows. */
  search(tokens: string[], clientId?: string): VaultItem[];
}

// Non-sensitive body is searchable; sensitive body (ciphertext ref) never is.
const SEARCH_COLUMNS_META = ['title', 'environment', 'tags', 'description', 'type'];

export function createVaultItemsRepo(db: Database): VaultItemsRepo {
  const insertStmt = db.prepare(
    `INSERT INTO vault_items
       (id, client_id, type, title, environment, tags, description, favorite, is_sensitive, body_plaintext, body_blob_ref, metadata)
     VALUES
       (@id, @clientId, @type, @title, @environment, @tags, @description, @favorite, @isSensitive, @bodyPlaintext, @bodyBlobRef, @metadata)`
  );
  const getByIdStmt = db.prepare<[string], VaultItemRow>('SELECT * FROM vault_items WHERE id = ?');
  const listByClientStmt = db.prepare<[string], VaultItemRow>(
    'SELECT * FROM vault_items WHERE client_id = ? ORDER BY favorite DESC, title'
  );
  const listByClientTypeStmt = db.prepare<[string, string], VaultItemRow>(
    'SELECT * FROM vault_items WHERE client_id = ? AND type = ? ORDER BY favorite DESC, title'
  );
  const listAllStmt = db.prepare<[], VaultItemRow>('SELECT * FROM vault_items ORDER BY favorite DESC, title');
  const deleteStmt = db.prepare('DELETE FROM vault_items WHERE id = ?');
  const setBodyRefStmt = db.prepare(
    `UPDATE vault_items SET body_blob_ref = @ref, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = @id`
  );

  return {
    create(input) {
      const id = randomUUID();
      insertStmt.run({
        id,
        clientId: input.clientId,
        type: input.type,
        title: input.title,
        environment: input.environment ?? null,
        tags: JSON.stringify(input.tags ?? []),
        description: input.description ?? null,
        favorite: input.favorite ? 1 : 0,
        isSensitive: input.isSensitive ? 1 : 0,
        bodyPlaintext: input.bodyPlaintext ?? null,
        bodyBlobRef: input.bodyBlobRef ?? null,
        metadata: JSON.stringify(input.metadata ?? {}),
      });
      return toDomain(getByIdStmt.get(id)!);
    },
    update(id, patch) {
      const current = getByIdStmt.get(id);
      if (!current) throw new Error(`Vault item ${id} not found.`);
      const sets: string[] = [];
      const params: Record<string, unknown> = { id };
      const put = (col: string, key: string, v: unknown) => {
        sets.push(`${col} = @${key}`);
        params[key] = v;
      };
      if (patch.title !== undefined) put('title', 'title', patch.title);
      if (patch.environment !== undefined) put('environment', 'environment', patch.environment);
      if (patch.tags !== undefined) put('tags', 'tags', JSON.stringify(patch.tags));
      if (patch.description !== undefined) put('description', 'description', patch.description);
      if (patch.favorite !== undefined) put('favorite', 'favorite', patch.favorite ? 1 : 0);
      if (patch.isSensitive !== undefined) put('is_sensitive', 'isSensitive', patch.isSensitive ? 1 : 0);
      if (patch.bodyPlaintext !== undefined) put('body_plaintext', 'bodyPlaintext', patch.bodyPlaintext);
      if (patch.bodyBlobRef !== undefined) put('body_blob_ref', 'bodyBlobRef', patch.bodyBlobRef);
      if (patch.metadata !== undefined) put('metadata', 'metadata', JSON.stringify(patch.metadata));
      if (sets.length > 0) {
        sets.push(`updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`);
        db.prepare(`UPDATE vault_items SET ${sets.join(', ')} WHERE id = @id`).run(params);
      }
      return toDomain(getByIdStmt.get(id)!);
    },
    delete(id) {
      const current = getByIdStmt.get(id);
      if (!current) throw new Error(`Vault item ${id} not found.`);
      deleteStmt.run(id);
      return { bodyBlobRef: current.body_blob_ref };
    },
    getById(id) {
      const row = getByIdStmt.get(id);
      return row ? toDomain(row) : null;
    },
    listByClient(clientId, type) {
      const rows = type ? listByClientTypeStmt.all(clientId, type) : listByClientStmt.all(clientId);
      return rows.map(toDomain);
    },
    listAll() {
      return listAllStmt.all().map(toDomain);
    },
    setBodyBlobRef(id, ref) {
      setBodyRefStmt.run({ id, ref });
    },
    search(tokens, clientId) {
      const clean = tokens.map((t) => t.trim()).filter(Boolean);
      if (clean.length === 0) return clientId ? this.listByClient(clientId) : this.listAll();
      const where: string[] = [];
      const params: unknown[] = [];
      for (const token of clean) {
        const cols = SEARCH_COLUMNS_META.map((c) => `${c} LIKE ?`);
        // non-sensitive body only
        cols.push('(is_sensitive = 0 AND body_plaintext LIKE ?)');
        where.push(`(${cols.join(' OR ')})`);
        for (let i = 0; i < SEARCH_COLUMNS_META.length + 1; i++) params.push(`%${token}%`);
      }
      let sql = `SELECT * FROM vault_items WHERE ${where.join(' AND ')}`;
      if (clientId) {
        sql += ' AND client_id = ?';
        params.push(clientId);
      }
      sql += ' ORDER BY favorite DESC, title';
      return db.prepare<unknown[], VaultItemRow>(sql).all(...params).map(toDomain);
    },
  };
}
