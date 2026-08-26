import type { Database } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { Transport } from '../../types.js';

interface TransportRow {
  id: string;
  client_id: string;
  name: string;
  type: string;
  host: string;
  port: number;
  username: string;
  private_key_path: string | null;
  passphrase_secret_ref: string | null;
  password_secret_ref: string | null;
  known_host_fingerprint: string | null;
  is_active: number;
  created_at: string;
  updated_at: string;
}

function toDomain(row: TransportRow): Transport {
  return {
    id: row.id,
    clientId: row.client_id,
    name: row.name,
    type: row.type as Transport['type'],
    host: row.host,
    port: row.port,
    username: row.username,
    privateKeyPath: row.private_key_path,
    passphraseSecretRef: row.passphrase_secret_ref,
    passwordSecretRef: row.password_secret_ref,
    knownHostFingerprint: row.known_host_fingerprint,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateSftpTransportInput {
  clientId: string;
  name: string;
  host: string;
  port?: number;
  username: string;
  privateKeyPath: string;
  passphraseSecretRef?: string | null;
  knownHostFingerprint?: string | null;
}

export interface CreateSshTransportInput {
  clientId: string;
  name: string;
  host: string;
  port?: number;
  username: string;
  privateKeyPath: string;
  passphraseSecretRef?: string | null;
  knownHostFingerprint?: string | null;
}

export interface CreateFtpTransportInput {
  clientId: string;
  name: string;
  host: string;
  port?: number;
  username: string;
  passwordSecretRef?: string | null;
}

/** `type` is deliberately not editable — changing between sftp/ssh/ftp means an entirely different set of required fields (see the table's CHECK constraint); create a new transport instead. */
export interface UpdateTransportInput {
  name?: string;
  host?: string;
  port?: number;
  username?: string;
  privateKeyPath?: string;
  passphraseSecretRef?: string | null;
  passwordSecretRef?: string | null;
}

export interface TransportsRepo {
  createSftp(input: CreateSftpTransportInput): Transport;
  createSsh(input: CreateSshTransportInput): Transport;
  createFtp(input: CreateFtpTransportInput): Transport;
  update(id: string, patch: UpdateTransportInput): Transport;
  deactivate(id: string): void;
  reactivate(id: string): void;
  getById(id: string): Transport | null;
  listByClient(clientId: string): Transport[];
  updateKnownHostFingerprint(id: string, fingerprint: string): void;
}

export function createTransportsRepo(db: Database): TransportsRepo {
  const insertSftpStmt = db.prepare(
    `INSERT INTO transports
       (id, client_id, name, type, host, port, username, private_key_path,
        passphrase_secret_ref, known_host_fingerprint)
     VALUES
       (@id, @clientId, @name, 'sftp', @host, @port, @username, @privateKeyPath,
        @passphraseSecretRef, @knownHostFingerprint)`
  );
  const insertSshStmt = db.prepare(
    `INSERT INTO transports
       (id, client_id, name, type, host, port, username, private_key_path,
        passphrase_secret_ref, known_host_fingerprint)
     VALUES
       (@id, @clientId, @name, 'ssh', @host, @port, @username, @privateKeyPath,
        @passphraseSecretRef, @knownHostFingerprint)`
  );
  const insertFtpStmt = db.prepare(
    `INSERT INTO transports
       (id, client_id, name, type, host, port, username, password_secret_ref)
     VALUES
       (@id, @clientId, @name, 'ftp', @host, @port, @username, @passwordSecretRef)`
  );
  const getByIdStmt = db.prepare<[string], TransportRow>('SELECT * FROM transports WHERE id = ?');
  const listByClientStmt = db.prepare<[string], TransportRow>(
    'SELECT * FROM transports WHERE client_id = ? ORDER BY name'
  );
  const updateFingerprintStmt = db.prepare(
    `UPDATE transports SET known_host_fingerprint = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
  );
  const updateStmt = db.prepare(
    `UPDATE transports
     SET name = @name, host = @host, port = @port, username = @username, private_key_path = @privateKeyPath,
         passphrase_secret_ref = @passphraseSecretRef, password_secret_ref = @passwordSecretRef,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = @id`
  );
  const deactivateStmt = db.prepare(
    `UPDATE transports SET is_active = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
  );
  const reactivateStmt = db.prepare(
    `UPDATE transports SET is_active = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
  );

  return {
    createSftp(input) {
      const id = randomUUID();
      insertSftpStmt.run({
        id,
        clientId: input.clientId,
        name: input.name,
        host: input.host,
        port: input.port ?? 22,
        username: input.username,
        privateKeyPath: input.privateKeyPath,
        passphraseSecretRef: input.passphraseSecretRef ?? null,
        knownHostFingerprint: input.knownHostFingerprint ?? null,
      });
      const row = getByIdStmt.get(id);
      if (!row) throw new Error(`Failed to read back created transport ${id}`);
      return toDomain(row);
    },

    createSsh(input) {
      const id = randomUUID();
      insertSshStmt.run({
        id,
        clientId: input.clientId,
        name: input.name,
        host: input.host,
        port: input.port ?? 22,
        username: input.username,
        privateKeyPath: input.privateKeyPath,
        passphraseSecretRef: input.passphraseSecretRef ?? null,
        knownHostFingerprint: input.knownHostFingerprint ?? null,
      });
      const row = getByIdStmt.get(id);
      if (!row) throw new Error(`Failed to read back created transport ${id}`);
      return toDomain(row);
    },

    createFtp(input) {
      const id = randomUUID();
      insertFtpStmt.run({
        id,
        clientId: input.clientId,
        name: input.name,
        host: input.host,
        port: input.port ?? 21,
        username: input.username,
        passwordSecretRef: input.passwordSecretRef ?? null,
      });
      const row = getByIdStmt.get(id);
      if (!row) throw new Error(`Failed to read back created transport ${id}`);
      return toDomain(row);
    },

    update(id, patch) {
      const current = getByIdStmt.get(id);
      if (!current) throw new Error(`Transport ${id} not found.`);
      updateStmt.run({
        id,
        name: patch.name ?? current.name,
        host: patch.host ?? current.host,
        port: patch.port ?? current.port,
        username: patch.username ?? current.username,
        privateKeyPath: patch.privateKeyPath !== undefined ? patch.privateKeyPath : current.private_key_path,
        passphraseSecretRef: patch.passphraseSecretRef !== undefined ? patch.passphraseSecretRef : current.passphrase_secret_ref,
        passwordSecretRef: patch.passwordSecretRef !== undefined ? patch.passwordSecretRef : current.password_secret_ref,
      });
      const row = getByIdStmt.get(id);
      if (!row) throw new Error(`Failed to read back updated transport ${id}`);
      return toDomain(row);
    },

    deactivate(id) {
      const current = getByIdStmt.get(id);
      if (!current) throw new Error(`Transport ${id} not found.`);
      deactivateStmt.run(id);
    },

    reactivate(id) {
      const current = getByIdStmt.get(id);
      if (!current) throw new Error(`Transport ${id} not found.`);
      reactivateStmt.run(id);
    },

    getById(id) {
      const row = getByIdStmt.get(id);
      return row ? toDomain(row) : null;
    },

    listByClient(clientId) {
      return listByClientStmt.all(clientId).map(toDomain);
    },

    updateKnownHostFingerprint(id, fingerprint) {
      updateFingerprintStmt.run(fingerprint, id);
    },
  };
}
