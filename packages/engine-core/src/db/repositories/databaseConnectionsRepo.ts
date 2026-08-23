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

/**
 * CRUD only — unused until the direct_dump strategy is implemented. Defined
 * now so that increment doesn't need a schema/repository-layer change.
 */
export interface DatabaseConnectionsRepo {
  create(input: CreateDatabaseConnectionInput): DatabaseConnection;
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

    getById(id) {
      const row = getByIdStmt.get(id);
      return row ? toDomain(row) : null;
    },

    listByClient(clientId) {
      return listByClientStmt.all(clientId).map(toDomain);
    },
  };
}
