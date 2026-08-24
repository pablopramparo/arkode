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
  private_key_path: string;
  passphrase_secret_ref: string | null;
  remote_path: string | null;
  remote_file_pattern: string | null;
  remote_command: string | null;
  remote_output_path_template: string | null;
  remote_cleanup: number;
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
    remotePath: row.remote_path,
    remoteFilePattern: row.remote_file_pattern,
    remoteCommand: row.remote_command,
    remoteOutputPathTemplate: row.remote_output_path_template,
    remoteCleanup: row.remote_cleanup === 1,
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
  remotePath: string;
  remoteFilePattern?: string | null;
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
  remoteCommand: string;
  remoteOutputPathTemplate: string;
  remoteCleanup?: boolean;
  knownHostFingerprint?: string | null;
}

export interface TransportsRepo {
  createSftp(input: CreateSftpTransportInput): Transport;
  createSsh(input: CreateSshTransportInput): Transport;
  getById(id: string): Transport | null;
  listByClient(clientId: string): Transport[];
  updateKnownHostFingerprint(id: string, fingerprint: string): void;
}

export function createTransportsRepo(db: Database): TransportsRepo {
  const insertSftpStmt = db.prepare(
    `INSERT INTO transports
       (id, client_id, name, type, host, port, username, private_key_path,
        passphrase_secret_ref, remote_path, remote_file_pattern, known_host_fingerprint)
     VALUES
       (@id, @clientId, @name, 'sftp', @host, @port, @username, @privateKeyPath,
        @passphraseSecretRef, @remotePath, @remoteFilePattern, @knownHostFingerprint)`
  );
  const insertSshStmt = db.prepare(
    `INSERT INTO transports
       (id, client_id, name, type, host, port, username, private_key_path,
        passphrase_secret_ref, remote_command, remote_output_path_template, remote_cleanup, known_host_fingerprint)
     VALUES
       (@id, @clientId, @name, 'ssh', @host, @port, @username, @privateKeyPath,
        @passphraseSecretRef, @remoteCommand, @remoteOutputPathTemplate, @remoteCleanup, @knownHostFingerprint)`
  );
  const getByIdStmt = db.prepare<[string], TransportRow>('SELECT * FROM transports WHERE id = ?');
  const listByClientStmt = db.prepare<[string], TransportRow>(
    'SELECT * FROM transports WHERE client_id = ? ORDER BY name'
  );
  const updateFingerprintStmt = db.prepare(
    `UPDATE transports SET known_host_fingerprint = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
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
        remotePath: input.remotePath,
        remoteFilePattern: input.remoteFilePattern ?? null,
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
        remoteCommand: input.remoteCommand,
        remoteOutputPathTemplate: input.remoteOutputPathTemplate,
        remoteCleanup: input.remoteCleanup ? 1 : 0,
        knownHostFingerprint: input.knownHostFingerprint ?? null,
      });
      const row = getByIdStmt.get(id);
      if (!row) throw new Error(`Failed to read back created transport ${id}`);
      return toDomain(row);
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
