import type { Database } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { DatabaseConnection } from '../../types.js';

interface DatabaseConnectionRow {
  id: string;
  client_id: string;
  name: string;
  engine: string;
  host: string;
  port: number;
  database_name: string;
  username: string;
  password_secret_ref: string | null;
  ssl_mode: string | null;
  is_active: number;
  created_at: string;
  updated_at: string;
}

function toDomain(row: DatabaseConnectionRow): DatabaseConnection {
  return {
    id: row.id,
    clientId: row.client_id,
    name: row.name,
    engine: row.engine as DatabaseConnection['engine'],
    host: row.host,
    port: row.port,
    databaseName: row.database_name,
    username: row.username,
    passwordSecretRef: row.password_secret_ref,
    sslMode: row.ssl_mode,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateDatabaseConnectionInput {
  clientId: string;
  name: string;
  engine: DatabaseConnection['engine'];
  host: string;
  port: number;
  databaseName: string;
  username: string;
  passwordSecretRef?: string | null;
  sslMode?: string | null;
}

/** `engine` is deliberately not editable — create a new connection instead of switching postgres/mysql/mariadb on an existing one. */
export interface UpdateDatabaseConnectionInput {
  name?: string;
  host?: string;
  port?: number;
  databaseName?: string;
  username?: string;
  passwordSecretRef?: string | null;
  sslMode?: string | null;
}

export interface DatabaseConnectionsRepo {
  create(input: CreateDatabaseConnectionInput): DatabaseConnection;
  update(id: string, patch: UpdateDatabaseConnectionInput): DatabaseConnection;
  deactivate(id: string): void;
  reactivate(id: string): void;
  getById(id: string): DatabaseConnection | null;
  listByClient(clientId: string): DatabaseConnection[];
}

export function createDatabaseConnectionsRepo(db: Database): DatabaseConnectionsRepo {
  const insertStmt = db.prepare(
    `INSERT INTO database_connections
       (id, client_id, name, engine, host, port, database_name, username, password_secret_ref, ssl_mode)
     VALUES
       (@id, @clientId, @name, @engine, @host, @port, @databaseName, @username, @passwordSecretRef, @sslMode)`
  );
  const getByIdStmt = db.prepare<[string], DatabaseConnectionRow>('SELECT * FROM database_connections WHERE id = ?');
  const listByClientStmt = db.prepare<[string], DatabaseConnectionRow>(
    'SELECT * FROM database_connections WHERE client_id = ? ORDER BY name'
  );
  const updateStmt = db.prepare(
    `UPDATE database_connections
     SET name = @name, host = @host, port = @port, database_name = @databaseName, username = @username,
         password_secret_ref = @passwordSecretRef, ssl_mode = @sslMode,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = @id`
  );
  const deactivateStmt = db.prepare(
    `UPDATE database_connections SET is_active = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
  );
  const reactivateStmt = db.prepare(
    `UPDATE database_connections SET is_active = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
  );

  return {
    create(input) {
      const id = randomUUID();
      insertStmt.run({
        id,
        clientId: input.clientId,
        name: input.name,
        engine: input.engine,
        host: input.host,
        port: input.port,
        databaseName: input.databaseName,
        username: input.username,
        passwordSecretRef: input.passwordSecretRef ?? null,
        sslMode: input.sslMode ?? null,
      });
      const row = getByIdStmt.get(id);
      if (!row) throw new Error(`Failed to read back created database connection ${id}`);
      return toDomain(row);
    },

    update(id, patch) {
      const current = getByIdStmt.get(id);
      if (!current) throw new Error(`Database connection ${id} not found.`);
      updateStmt.run({
        id,
        name: patch.name ?? current.name,
        host: patch.host ?? current.host,
        port: patch.port ?? current.port,
        databaseName: patch.databaseName ?? current.database_name,
        username: patch.username ?? current.username,
        passwordSecretRef: patch.passwordSecretRef !== undefined ? patch.passwordSecretRef : current.password_secret_ref,
        sslMode: patch.sslMode !== undefined ? patch.sslMode : current.ssl_mode,
      });
      const row = getByIdStmt.get(id);
      if (!row) throw new Error(`Failed to read back updated database connection ${id}`);
      return toDomain(row);
    },

    deactivate(id) {
      const current = getByIdStmt.get(id);
      if (!current) throw new Error(`Database connection ${id} not found.`);
      deactivateStmt.run(id);
    },

    reactivate(id) {
      const current = getByIdStmt.get(id);
      if (!current) throw new Error(`Database connection ${id} not found.`);
      reactivateStmt.run(id);
    },

    getById(id) {
      const row = getByIdStmt.get(id);
      return row ? toDomain(row) : null;
    },

    listByClient(clientId) {
      return listByClientStmt.all(clientId).map(toDomain);
    },
  };
}
