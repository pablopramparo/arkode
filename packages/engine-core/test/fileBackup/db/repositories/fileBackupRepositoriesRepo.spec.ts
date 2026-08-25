import Database from 'better-sqlite3';
import { describe, expect, it, beforeEach } from 'vitest';
import { runMigrations } from '../../../../src/db/migrate.js';
import { migrationsSourceDir } from '../../../../src/paths.js';
import { createClientsRepo, type ClientsRepo } from '../../../../src/db/repositories/clientsRepo.js';
import {
  createFileBackupRepositoriesRepo,
  type FileBackupRepositoriesRepo,
} from '../../../../src/fileBackup/db/repositories/fileBackupRepositoriesRepo.js';

function freshDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrationsSourceDir());
  return db;
}

describe('fileBackupRepositoriesRepo', () => {
  let clientsRepo: ClientsRepo;
  let repo: FileBackupRepositoriesRepo;
  let clientId: string;

  beforeEach(() => {
    const db = freshDb();
    clientsRepo = createClientsRepo(db);
    repo = createFileBackupRepositoriesRepo(db);
    clientId = clientsRepo.create({ name: 'Acme', localBasePath: 'D:\\Backups\\Acme' }).id;
  });

  it('creates a repository and reads it back', () => {
    const created = repo.create({ clientId, repoPath: 'D:\\Backups\\Acme\\_restic-repo', passwordSecretRef: 'ref-1' });
    expect(created.id).toBeTruthy();
    expect(created.clientId).toBe(clientId);
    expect(created.repoPath).toBe('D:\\Backups\\Acme\\_restic-repo');
    expect(created.initializedAt).toBeNull();
    expect(created.lastPrunedAt).toBeNull();
    expect(created.lastCheckedAt).toBeNull();

    expect(repo.getById(created.id)).toEqual(created);
    expect(repo.getByClientId(clientId)).toEqual(created);
  });

  it('enforces one repository per client with a friendly error', () => {
    repo.create({ clientId, repoPath: 'D:\\Backups\\Acme\\_restic-repo', passwordSecretRef: 'ref-1' });
    expect(() => repo.create({ clientId, repoPath: 'D:\\Backups\\Acme\\_restic-repo-2', passwordSecretRef: 'ref-2' })).toThrow(
      /already has a file-backup repository/
    );
  });

  it('marks a repository initialized, recording the restic repo id', () => {
    const created = repo.create({ clientId, repoPath: 'D:\\Backups\\Acme\\_restic-repo', passwordSecretRef: 'ref-1' });
    repo.markInitialized(created.id, 'abc123');
    const updated = repo.getById(created.id);
    expect(updated?.initializedAt).not.toBeNull();
    expect(updated?.resticRepoId).toBe('abc123');
  });

  it('marks pruned/checked timestamps independently', () => {
    const created = repo.create({ clientId, repoPath: 'D:\\Backups\\Acme\\_restic-repo', passwordSecretRef: 'ref-1' });
    repo.markPruned(created.id);
    const afterPrune = repo.getById(created.id);
    expect(afterPrune?.lastPrunedAt).not.toBeNull();
    expect(afterPrune?.lastCheckedAt).toBeNull();

    repo.markChecked(created.id);
    const afterCheck = repo.getById(created.id);
    expect(afterCheck?.lastCheckedAt).not.toBeNull();
  });

  it('listForActiveClients only includes repositories whose client is active', () => {
    const created = repo.create({ clientId, repoPath: 'D:\\Backups\\Acme\\_restic-repo', passwordSecretRef: 'ref-1' });
    expect(repo.listForActiveClients().map((r) => r.id)).toEqual([created.id]);

    clientsRepo.deactivate(clientId);
    expect(repo.listForActiveClients()).toEqual([]);
  });

  it('getByClientId returns null when the client has no repository yet', () => {
    expect(repo.getByClientId(clientId)).toBeNull();
  });
});
