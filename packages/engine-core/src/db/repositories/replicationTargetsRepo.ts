import type { Database } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type {
  ReplicationContent,
  ReplicationLastStatus,
  ReplicationTarget,
} from '../../replication/types.js';

interface ReplicationTargetRow {
  id: string;
  client_id: string;
  content: string;
  provider: string;
  remote_path: string;
  rclone_config_secret_ref: string | null;
  transport_id: string | null;
  sftp_host_key: string | null;
  sftp_host_key_fingerprint: string | null;
  encrypt_with_crypt: number;
  crypt_password_secret_ref: string | null;
  enabled: number;
  last_replicated_at: string | null;
  last_status: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

function toDomain(row: ReplicationTargetRow): ReplicationTarget {
  return {
    id: row.id,
    clientId: row.client_id,
    content: row.content as ReplicationContent,
    provider: row.provider as ReplicationTarget['provider'],
    remotePath: row.remote_path,
    rcloneConfigSecretRef: row.rclone_config_secret_ref,
    transportId: row.transport_id,
    sftpHostKey: row.sftp_host_key,
    sftpHostKeyFingerprint: row.sftp_host_key_fingerprint,
    encryptWithCrypt: row.encrypt_with_crypt === 1,
    cryptPasswordSecretRef: row.crypt_password_secret_ref,
    enabled: row.enabled === 1,
    lastReplicatedAt: row.last_replicated_at,
    lastStatus: (row.last_status as ReplicationLastStatus | null) ?? null,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateReplicationTargetInput {
  clientId: string;
  content: ReplicationContent;
  provider: ReplicationTarget['provider'];
  remotePath: string;
  /** Required iff provider === 'rclone_drive'. */
  rcloneConfigSecretRef?: string;
  /** Required iff provider is 'rclone_sftp' or 'rclone_ftp'. */
  transportId?: string;
  encryptWithCrypt: boolean;
  cryptPasswordSecretRef: string | null;
}

export interface UpdateReplicationTargetInput {
  remotePath?: string;
  enabled?: boolean;
}

export interface ReplicationTargetsRepo {
  create(input: CreateReplicationTargetInput): ReplicationTarget;
  getById(id: string): ReplicationTarget | null;
  getByClientAndContent(clientId: string, content: ReplicationContent): ReplicationTarget | null;
  listByClient(clientId: string): ReplicationTarget[];
  /** Every enabled target whose client is active — what the scheduler tick iterates. */
  listEnabled(): ReplicationTarget[];
  update(id: string, input: UpdateReplicationTargetInput): void;
  recordResult(id: string, status: ReplicationLastStatus, error: string | null): void;
  /** Persists the target's pinned SFTP host key(s) — rclone_sftp only, set once on first successful test/run. */
  setSftpHostKey(id: string, knownHostsContent: string, fingerprintDisplay: string): void;
  remove(id: string): void;
}

function friendlyUniqueError(err: unknown): never {
  if (
    err instanceof Error &&
    /UNIQUE constraint failed: replication_targets\.client_id, replication_targets\.content/.test(err.message)
  ) {
    throw new Error('This client already has a replication target for that content kind.');
  }
  throw err;
}

export function createReplicationTargetsRepo(db: Database): ReplicationTargetsRepo {
  const insertStmt = db.prepare(
    `INSERT INTO replication_targets
       (id, client_id, content, provider, remote_path, rclone_config_secret_ref, transport_id, encrypt_with_crypt, crypt_password_secret_ref)
     VALUES (@id, @clientId, @content, @provider, @remotePath, @rcloneConfigSecretRef, @transportId, @encryptWithCrypt, @cryptPasswordSecretRef)`
  );
  const setSftpHostKeyStmt = db.prepare(
    `UPDATE replication_targets
     SET sftp_host_key = @knownHostsContent,
         sftp_host_key_fingerprint = @fingerprintDisplay,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = @id`
  );
  const getByIdStmt = db.prepare<[string], ReplicationTargetRow>('SELECT * FROM replication_targets WHERE id = ?');
  const getByClientAndContentStmt = db.prepare<[string, string], ReplicationTargetRow>(
    'SELECT * FROM replication_targets WHERE client_id = ? AND content = ?'
  );
  const listByClientStmt = db.prepare<[string], ReplicationTargetRow>(
    'SELECT * FROM replication_targets WHERE client_id = ? ORDER BY content'
  );
  const listEnabledStmt = db.prepare<[], ReplicationTargetRow>(
    `SELECT t.* FROM replication_targets t
     JOIN clients c ON c.id = t.client_id
     WHERE t.enabled = 1 AND c.is_active = 1
     ORDER BY t.created_at`
  );
  const recordResultStmt = db.prepare(
    `UPDATE replication_targets
     SET last_replicated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
         last_status = @status,
         last_error = @error,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = @id`
  );
  const removeStmt = db.prepare('DELETE FROM replication_targets WHERE id = ?');

  return {
    create(input) {
      if (input.provider === 'rclone_drive') {
        if (!input.rcloneConfigSecretRef) {
          throw new Error('A Google Drive replication target requires rcloneConfigSecretRef.');
        }
        if (input.transportId) {
          throw new Error('A Google Drive replication target cannot be linked to a transport.');
        }
      } else {
        if (!input.transportId) {
          throw new Error(`A ${input.provider} replication target requires transportId.`);
        }
        if (input.rcloneConfigSecretRef) {
          throw new Error(`A ${input.provider} replication target cannot have rcloneConfigSecretRef.`);
        }
      }

      const id = randomUUID();
      try {
        insertStmt.run({
          id,
          clientId: input.clientId,
          content: input.content,
          provider: input.provider,
          remotePath: input.remotePath,
          rcloneConfigSecretRef: input.rcloneConfigSecretRef ?? null,
          transportId: input.transportId ?? null,
          encryptWithCrypt: input.encryptWithCrypt ? 1 : 0,
          cryptPasswordSecretRef: input.cryptPasswordSecretRef,
        });
      } catch (err) {
        friendlyUniqueError(err);
      }
      const row = getByIdStmt.get(id);
      if (!row) throw new Error(`Failed to read back created replication_target ${id}`);
      return toDomain(row);
    },

    getById(id) {
      const row = getByIdStmt.get(id);
      return row ? toDomain(row) : null;
    },

    getByClientAndContent(clientId, content) {
      const row = getByClientAndContentStmt.get(clientId, content);
      return row ? toDomain(row) : null;
    },

    listByClient(clientId) {
      return listByClientStmt.all(clientId).map(toDomain);
    },

    listEnabled() {
      return listEnabledStmt.all().map(toDomain);
    },

    update(id, input) {
      const sets: string[] = [];
      const params: Record<string, unknown> = { id };
      if (input.remotePath !== undefined) {
        sets.push('remote_path = @remotePath');
        params.remotePath = input.remotePath;
      }
      if (input.enabled !== undefined) {
        sets.push('enabled = @enabled');
        params.enabled = input.enabled ? 1 : 0;
      }
      if (sets.length === 0) return;
      sets.push(`updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`);
      db.prepare(`UPDATE replication_targets SET ${sets.join(', ')} WHERE id = @id`).run(params);
    },

    recordResult(id, status, error) {
      recordResultStmt.run({ id, status, error });
    },

    setSftpHostKey(id, knownHostsContent, fingerprintDisplay) {
      setSftpHostKeyStmt.run({ id, knownHostsContent, fingerprintDisplay });
    },

    remove(id) {
      removeStmt.run(id);
    },
  };
}
