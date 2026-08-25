import Database from 'better-sqlite3';
import { describe, expect, it, beforeEach } from 'vitest';
import { runMigrations } from '../../../../src/db/migrate.js';
import { migrationsSourceDir } from '../../../../src/paths.js';
import { createClientsRepo, type ClientsRepo } from '../../../../src/db/repositories/clientsRepo.js';
import { createFileBackupRepositoriesRepo, type FileBackupRepositoriesRepo } from '../../../../src/fileBackup/db/repositories/fileBackupRepositoriesRepo.js';
import { createFileBackupTasksRepo, type FileBackupTasksRepo } from '../../../../src/fileBackup/db/repositories/fileBackupTasksRepo.js';
import { createFileBackupRunsRepo, type FileBackupRunsRepo } from '../../../../src/fileBackup/db/repositories/fileBackupRunsRepo.js';

function freshDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrationsSourceDir());
  return db;
}

describe('fileBackupRunsRepo', () => {
  let clientsRepo: ClientsRepo;
  let reposRepo: FileBackupRepositoriesRepo;
  let tasksRepo: FileBackupTasksRepo;
  let runsRepo: FileBackupRunsRepo;
  let clientId: string;
  let repositoryId: string;
  let taskId: string;

  beforeEach(() => {
    const db = freshDb();
    clientsRepo = createClientsRepo(db);
    reposRepo = createFileBackupRepositoriesRepo(db);
    tasksRepo = createFileBackupTasksRepo(db);
    runsRepo = createFileBackupRunsRepo(db);
    clientId = clientsRepo.create({ name: 'Acme', localBasePath: 'D:\\Backups\\Acme' }).id;
    repositoryId = reposRepo.create({ clientId, repoPath: 'D:\\Backups\\Acme\\_restic-repo', passwordSecretRef: 'ref-1' }).id;
    taskId = tasksRepo.createLocalFolder({ clientId, repositoryId, name: 'Uploads', sourcePath: 'D:\\Sites\\acme\\uploads' }).id;
  });

  it('creates a run as Running and progresses through Producing -> summary -> finished', () => {
    const run = runsRepo.create({ taskId, clientId, repositoryId, pid: process.pid });
    expect(run.status).toBe('Running');

    runsRepo.markProducing(run.id);
    expect(runsRepo.getById(run.id)?.status).toBe('Producing');

    runsRepo.recordBackupSummary(run.id, {
      snapshotId: 'snap-1',
      filesNew: 3,
      filesChanged: 1,
      filesUnmodified: 10,
      filesDeleted: 0,
      dirsNew: 1,
      dirsChanged: 0,
      totalFilesProcessed: 14,
      totalBytesProcessed: 1024,
      dataAdded: 512,
      dataAddedPacked: 256,
      warnings: [],
    });
    const validating = runsRepo.getById(run.id);
    expect(validating?.status).toBe('Validating');
    expect(validating?.snapshotId).toBe('snap-1');
    expect(validating?.filesNew).toBe(3);
    expect(validating?.warnings).toBeNull();

    runsRepo.markFinished(run.id, 'Success');
    const finished = runsRepo.getById(run.id);
    expect(finished?.status).toBe('Success');
    expect(finished?.finishedAt).not.toBeNull();
    expect(finished?.durationMs).not.toBeNull();
  });

  it('stores warnings as JSON and reads them back as a string array', () => {
    const run = runsRepo.create({ taskId, clientId, repositoryId, pid: process.pid });
    runsRepo.recordBackupSummary(run.id, {
      snapshotId: 'snap-1',
      filesNew: 0,
      filesChanged: 0,
      filesUnmodified: 0,
      filesDeleted: 0,
      dirsNew: 0,
      dirsChanged: 0,
      totalFilesProcessed: 0,
      totalBytesProcessed: 0,
      dataAdded: 0,
      dataAddedPacked: 0,
      warnings: ['The source folder was empty — the snapshot contains no files.'],
    });
    expect(runsRepo.getById(run.id)?.warnings).toEqual(['The source folder was empty — the snapshot contains no files.']);
  });

  it('getLatestSuccessfulByTask only returns Success runs that actually produced a snapshot', () => {
    const run1 = runsRepo.create({ taskId, clientId, repositoryId, pid: process.pid });
    runsRepo.markFinished(run1.id, 'Failed', { errorMessage: 'boom' });
    expect(runsRepo.getLatestSuccessfulByTask(taskId)).toBeNull();

    const run2 = runsRepo.create({ taskId, clientId, repositoryId, pid: process.pid });
    runsRepo.recordBackupSummary(run2.id, {
      snapshotId: 'snap-2',
      filesNew: 1,
      filesChanged: 0,
      filesUnmodified: 0,
      filesDeleted: 0,
      dirsNew: 0,
      dirsChanged: 0,
      totalFilesProcessed: 1,
      totalBytesProcessed: 10,
      dataAdded: 10,
      dataAddedPacked: 10,
      warnings: [],
    });
    runsRepo.markFinished(run2.id, 'Success');

    expect(runsRepo.getLatestSuccessfulByTask(taskId)?.id).toBe(run2.id);
  });

  it('listInProgressByRepository reflects runs across every task sharing that repository', () => {
    const task2Id = tasksRepo.createLocalFolder({ clientId, repositoryId, name: 'Docs', sourcePath: 'D:\\Sites\\acme\\docs' }).id;
    const run1 = runsRepo.create({ taskId, clientId, repositoryId, pid: process.pid });
    const run2 = runsRepo.create({ taskId: task2Id, clientId, repositoryId, pid: process.pid });

    expect(runsRepo.listInProgressByRepository(repositoryId).map((r) => r.id).sort()).toEqual([run1.id, run2.id].sort());

    runsRepo.markFinished(run1.id, 'Success');
    expect(runsRepo.listInProgressByRepository(repositoryId).map((r) => r.id)).toEqual([run2.id]);
  });

  it('listRecent filters by taskId/clientId and orders newest first', () => {
    const run1 = runsRepo.create({ taskId, clientId, repositoryId, pid: process.pid });
    runsRepo.markFinished(run1.id, 'Success');
    const run2 = runsRepo.create({ taskId, clientId, repositoryId, pid: process.pid });
    runsRepo.markFinished(run2.id, 'Failed');

    const recent = runsRepo.listRecent({ taskId });
    expect(recent.map((r) => r.id)).toEqual([run2.id, run1.id]);
    expect(runsRepo.listRecent({ clientId }).length).toBe(2);
    expect(runsRepo.listRecent({ taskId: 'nonexistent' })).toEqual([]);
  });
});
