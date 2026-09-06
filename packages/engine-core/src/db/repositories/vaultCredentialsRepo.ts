import type { Database } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import {
  VAULT_CREDENTIAL_KINDS,
  linkTargetForKind,
  type OperationalSyncState,
  type VaultCredential,
  type VaultCredentialKind,
} from '../../vault/types.js';

interface VaultCredentialRow {
  id: string;
  client_id: string;
  name: string;
  kind: string;
  environment: string | null;
  tags: string;
  host: string | null;
  port: number | null;
  username: string | null;
  database_name: string | null;
  url: string | null;
  secret_blob_ref: string | null;
  linked_transport_id: string | null;
  linked_database_connection_id: string | null;
  operational_sync_state: string;
  operational_sync_error: string | null;
  favorite: number;
  description: string | null;
  created_at: string;
  updated_at: string;
}

function toDomain(row: VaultCredentialRow): VaultCredential {
  let tags: string[] = [];
  try {
    const parsed = JSON.parse(row.tags) as unknown;
    if (Array.isArray(parsed)) tags = parsed.filter((t): t is string => typeof t === 'string');
  } catch {
    /* leave tags empty on a malformed value */
  }
  return {
    id: row.id,
    clientId: row.client_id,
    name: row.name,
    kind: row.kind as VaultCredentialKind,
    environment: row.environment,
    tags,
    host: row.host,
    port: row.port,
    username: row.username,
    databaseName: row.database_name,
    url: row.url,
    secretBlobRef: row.secret_blob_ref,
    linkedTransportId: row.linked_transport_id,
    linkedDatabaseConnectionId: row.linked_database_connection_id,
    operationalSyncState: row.operational_sync_state as OperationalSyncState,
    operationalSyncError: row.operational_sync_error,
    favorite: row.favorite === 1,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateVaultCredentialInput {
  clientId: string;
  name: string;
  kind: VaultCredentialKind;
  environment?: string | null;
  tags?: string[];
  host?: string | null;
  port?: number | null;
  username?: string | null;
  databaseName?: string | null;
  url?: string | null;
  secretBlobRef?: string | null;
  favorite?: boolean;
  description?: string | null;
}

export interface UpdateVaultCredentialInput {
  name?: string;
  /**
   * `kind` decides which connection kind the reuse bridge may link, so it can
   * only change while the credential is NOT linked to a transport / database
   * connection. `update()` rejects a change on a linked credential.
   */
  kind?: VaultCredentialKind;
  environment?: string | null;
  tags?: string[];
  host?: string | null;
  port?: number | null;
  username?: string | null;
  databaseName?: string | null;
  url?: string | null;
  favorite?: boolean;
  description?: string | null;
}

export interface SetLinkInput {
  linkedTransportId?: string | null;
  linkedDatabaseConnectionId?: string | null;
}

export interface VaultCredentialsRepo {
  create(input: CreateVaultCredentialInput): VaultCredential;
  update(id: string, patch: UpdateVaultCredentialInput): VaultCredential;
  /** Deletes the row, returning its `secretBlobRef` so the caller can drop the encrypted blob too. */
  delete(id: string): { secretBlobRef: string | null };
  setSecretBlobRef(id: string, ref: string | null): void;
  getById(id: string): VaultCredential | null;
  listByClient(clientId: string): VaultCredential[];
  listAll(): VaultCredential[];
  /** Metadata `LIKE` scan: every token must match some searchable column. Never touches ciphertext. */
  search(tokens: string[], clientId?: string): VaultCredential[];
  getByLinkedTransportId(transportId: string): VaultCredential | null;
  getByLinkedDatabaseConnectionId(dbConnId: string): VaultCredential | null;
  /** Reuse bridge (Phase 3). Rejects a partial-UNIQUE collision with a clear message. */
  setLink(id: string, link: SetLinkInput): VaultCredential;
  setOperationalSyncState(id: string, state: OperationalSyncState, error?: string | null): void;
}

function friendlyLinkCollision(err: unknown): never {
  if (err instanceof Error && /UNIQUE constraint failed: vault_credentials\.linked_transport_id/.test(err.message)) {
    throw new Error('That connection is already owned by another vault credential.');
  }
  if (
    err instanceof Error &&
    /UNIQUE constraint failed: vault_credentials\.linked_database_connection_id/.test(err.message)
  ) {
    throw new Error('That database connection is already owned by another vault credential.');
  }
  throw err;
}

export function createVaultCredentialsRepo(db: Database): VaultCredentialsRepo {
  const insertStmt = db.prepare(
    `INSERT INTO vault_credentials
       (id, client_id, name, kind, environment, tags, host, port, username, database_name, url,
        secret_blob_ref, favorite, description)
     VALUES
       (@id, @clientId, @name, @kind, @environment, @tags, @host, @port, @username, @databaseName, @url,
        @secretBlobRef, @favorite, @description)`
  );
  const getByIdStmt = db.prepare<[string], VaultCredentialRow>('SELECT * FROM vault_credentials WHERE id = ?');
  const listByClientStmt = db.prepare<[string], VaultCredentialRow>(
    'SELECT * FROM vault_credentials WHERE client_id = ? ORDER BY favorite DESC, name'
  );
  const listAllStmt = db.prepare<[], VaultCredentialRow>('SELECT * FROM vault_credentials ORDER BY favorite DESC, name');
  const getByLinkedTransportStmt = db.prepare<[string], VaultCredentialRow>(
    'SELECT * FROM vault_credentials WHERE linked_transport_id = ?'
  );
  const getByLinkedDbConnStmt = db.prepare<[string], VaultCredentialRow>(
    'SELECT * FROM vault_credentials WHERE linked_database_connection_id = ?'
  );
  const deleteStmt = db.prepare('DELETE FROM vault_credentials WHERE id = ?');
  const setSyncStmt = db.prepare(
    `UPDATE vault_credentials
       SET operational_sync_state = @state, operational_sync_error = @error,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = @id`
  );
  const setSecretRefStmt = db.prepare(
    `UPDATE vault_credentials
       SET secret_blob_ref = @ref, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = @id`
  );
  const setLinkStmt = db.prepare(
    `UPDATE vault_credentials
       SET linked_transport_id = @linkedTransportId,
           linked_database_connection_id = @linkedDatabaseConnectionId,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = @id`
  );

  const SEARCH_COLUMNS = [
    'name',
    'host',
    'username',
    'database_name',
    'url',
    'environment',
    'tags',
    'description',
    'kind',
  ];

  return {
    create(input) {
      if (!VAULT_CREDENTIAL_KINDS.includes(input.kind)) {
        throw new Error(`Unknown credential kind "${input.kind}".`);
      }
      const id = randomUUID();
      insertStmt.run({
        id,
        clientId: input.clientId,
        name: input.name,
        kind: input.kind,
        environment: input.environment ?? null,
        tags: JSON.stringify(input.tags ?? []),
        host: input.host ?? null,
        port: input.port ?? null,
        username: input.username ?? null,
        databaseName: input.databaseName ?? null,
        url: input.url ?? null,
        secretBlobRef: input.secretBlobRef ?? null,
        favorite: input.favorite ? 1 : 0,
        description: input.description ?? null,
      });
      const row = getByIdStmt.get(id);
      if (!row) throw new Error(`Failed to read back created vault_credential ${id}`);
      return toDomain(row);
    },

    update(id, patch) {
      const current = getByIdStmt.get(id);
      if (!current) throw new Error(`Vault credential ${id} not found.`);
      const sets: string[] = [];
      const params: Record<string, unknown> = { id };
      const put = (col: string, key: string, value: unknown) => {
        sets.push(`${col} = @${key}`);
        params[key] = value;
      };
      if (patch.name !== undefined) put('name', 'name', patch.name);
      if (patch.kind !== undefined && patch.kind !== current.kind) {
        if (!VAULT_CREDENTIAL_KINDS.includes(patch.kind)) {
          throw new Error(`Unknown credential kind "${patch.kind}".`);
        }
        if (current.linked_transport_id || current.linked_database_connection_id) {
          throw new Error(
            "Unlink this credential from backups before changing its kind (the link depends on the kind)."
          );
        }
        put('kind', 'kind', patch.kind);
      }
      if (patch.environment !== undefined) put('environment', 'environment', patch.environment);
      if (patch.tags !== undefined) put('tags', 'tags', JSON.stringify(patch.tags));
      if (patch.host !== undefined) put('host', 'host', patch.host);
      if (patch.port !== undefined) put('port', 'port', patch.port);
      if (patch.username !== undefined) put('username', 'username', patch.username);
      if (patch.databaseName !== undefined) put('database_name', 'databaseName', patch.databaseName);
      if (patch.url !== undefined) put('url', 'url', patch.url);
      if (patch.favorite !== undefined) put('favorite', 'favorite', patch.favorite ? 1 : 0);
      if (patch.description !== undefined) put('description', 'description', patch.description);
      if (sets.length > 0) {
        sets.push(`updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`);
        db.prepare(`UPDATE vault_credentials SET ${sets.join(', ')} WHERE id = @id`).run(params);
      }
      return toDomain(getByIdStmt.get(id)!);
    },

    delete(id) {
      const current = getByIdStmt.get(id);
      if (!current) throw new Error(`Vault credential ${id} not found.`);
      deleteStmt.run(id);
      return { secretBlobRef: current.secret_blob_ref };
    },

    setSecretBlobRef(id, ref) {
      setSecretRefStmt.run({ id, ref });
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
      const clean = tokens.map((t) => t.trim()).filter((t) => t.length > 0);
      if (clean.length === 0) return clientId ? this.listByClient(clientId) : this.listAll();
      const where: string[] = [];
      const params: unknown[] = [];
      for (const token of clean) {
        where.push(`(${SEARCH_COLUMNS.map((c) => `${c} LIKE ?`).join(' OR ')})`);
        for (let i = 0; i < SEARCH_COLUMNS.length; i++) params.push(`%${token}%`);
      }
      let sql = `SELECT * FROM vault_credentials WHERE ${where.join(' AND ')}`;
      if (clientId) {
        sql += ' AND client_id = ?';
        params.push(clientId);
      }
      sql += ' ORDER BY favorite DESC, name';
      return db
        .prepare<unknown[], VaultCredentialRow>(sql)
        .all(...params)
        .map(toDomain);
    },

    getByLinkedTransportId(transportId) {
      const row = getByLinkedTransportStmt.get(transportId);
      return row ? toDomain(row) : null;
    },

    getByLinkedDatabaseConnectionId(dbConnId) {
      const row = getByLinkedDbConnStmt.get(dbConnId);
      return row ? toDomain(row) : null;
    },

    setLink(id, link) {
      const current = getByIdStmt.get(id);
      if (!current) throw new Error(`Vault credential ${id} not found.`);
      const target = linkTargetForKind(current.kind as VaultCredentialKind);
      const nextTransport = link.linkedTransportId !== undefined ? link.linkedTransportId : current.linked_transport_id;
      const nextDbConn =
        link.linkedDatabaseConnectionId !== undefined
          ? link.linkedDatabaseConnectionId
          : current.linked_database_connection_id;
      if (nextTransport && nextDbConn) {
        throw new Error('A vault credential links to at most one of a transport or a database connection.');
      }
      if (nextTransport && target !== 'transport') {
        throw new Error(`A "${current.kind}" credential cannot link to a transport.`);
      }
      if (nextDbConn && target !== 'database_connection') {
        throw new Error(`A "${current.kind}" credential cannot link to a database connection.`);
      }
      try {
        setLinkStmt.run({ id, linkedTransportId: nextTransport, linkedDatabaseConnectionId: nextDbConn });
      } catch (err) {
        friendlyLinkCollision(err);
      }
      return toDomain(getByIdStmt.get(id)!);
    },

    setOperationalSyncState(id, state, error) {
      setSyncStmt.run({ id, state, error: error ?? null });
    },
  };
}
