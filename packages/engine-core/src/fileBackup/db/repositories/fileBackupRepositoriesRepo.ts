import type { Database } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { FileBackupRepository } from '../../types.js';

interface FileBackupRepositoryRow {
  id: string;
  client_id: string;
  repo_path: string;
  password_secret_ref: string;
  restic_repo_id: string | null;
  last_pruned_at: string | null;
  last_checked_at: string | null;
  initialized_at: string | null;
  created_at: string;
  updated_at: string;
}

function toDomain(row: FileBackupRepositoryRow): FileBackupRepository {
  return {
    id: row.id,
    clientId: row.client_id,
    repoPath: row.repo_path,
    passwordSecretRef: row.password_secret_ref,
    resticRepoId: row.restic_repo_id,
    lastPrunedAt: row.last_pruned_at,
    lastCheckedAt: row.last_checked_at,
    initializedAt: row.initialized_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateFileBackupRepositoryInput {
  clientId: string;
  repoPath: string;
  passwordSecretRef: string;
}

export interface FileBackupRepositoriesRepo {
  create(input: CreateFileBackupRepositoryInput): FileBackupRepository;
  getById(id: string): FileBackupRepository | null;
  getByClientId(clientId: string): FileBackupRepository | null;
  /** Every repository whose client is currently active — what a maintenance sweep with no `--repo` filter iterates over. */
  listForActiveClients(): FileBackupRepository[];
  markInitialized(id: string, resticRepoId: string | null): void;
  markPruned(id: string): void;
  markChecked(id: string): void;
}

function friendlyUniqueClientError(err: unknown): never {
  if (err instanceof Error && /UNIQUE constraint failed: file_backup_repositories\.client_id/.test(err.message)) {
    throw new Error('This client already has a file-backup repository — one repository is shared by all of a client\'s file-backup tasks.');
  }
  throw err;
}

export function createFileBackupRepositoriesRepo(db: Database): FileBackupRepositoriesRepo {
  const insertStmt = db.prepare(
    `INSERT INTO file_backup_repositories (id, client_id, repo_path, password_secret_ref)
     VALUES (@id, @clientId, @repoPath, @passwordSecretRef)`
  );
  const getByIdStmt = db.prepare<[string], FileBackupRepositoryRow>(
    'SELECT * FROM file_backup_repositories WHERE id = ?'
  );
  const getByClientIdStmt = db.prepare<[string], FileBackupRepositoryRow>(
    'SELECT * FROM file_backup_repositories WHERE client_id = ?'
  );
  const listForActiveClientsStmt = db.prepare<[], FileBackupRepositoryRow>(
    `SELECT r.* FROM file_backup_repositories r
     JOIN clients c ON c.id = r.client_id
     WHERE c.is_active = 1
     ORDER BY r.created_at`
  );
  const markInitializedStmt = db.prepare(
    `UPDATE file_backup_repositories
     SET initialized_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), restic_repo_id = @resticRepoId,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = @id`
  );
  const markPrunedStmt = db.prepare(
    `UPDATE file_backup_repositories
     SET last_pruned_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = ?`
  );
  const markCheckedStmt = db.prepare(
    `UPDATE file_backup_repositories
     SET last_checked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = ?`
  );

  return {
    create(input) {
      const id = randomUUID();
      try {
        insertStmt.run({
          id,
          clientId: input.clientId,
          repoPath: input.repoPath,
          passwordSecretRef: input.passwordSecretRef,
        });
      } catch (err) {
        friendlyUniqueClientError(err);
      }
      const row = getByIdStmt.get(id);
      if (!row) throw new Error(`Failed to read back created file_backup_repository ${id}`);
      return toDomain(row);
    },

    getById(id) {
      const row = getByIdStmt.get(id);
      return row ? toDomain(row) : null;
    },

    getByClientId(clientId) {
      const row = getByClientIdStmt.get(clientId);
      return row ? toDomain(row) : null;
    },

    listForActiveClients() {
      return listForActiveClientsStmt.all().map(toDomain);
    },

    markInitialized(id, resticRepoId) {
      markInitializedStmt.run({ id, resticRepoId });
    },

    markPruned(id) {
      markPrunedStmt.run(id);
    },

    markChecked(id) {
      markCheckedStmt.run(id);
    },
  };
}
