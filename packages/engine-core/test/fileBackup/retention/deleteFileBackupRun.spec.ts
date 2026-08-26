import Database from 'better-sqlite3';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../../src/db/migrate.js';
import { migrationsSourceDir } from '../../../src/paths.js';
import { createClientsRepo } from '../../../src/db/repositories/clientsRepo.js';
import { createTransportsRepo } from '../../../src/db/repositories/transportsRepo.js';
import { createFileBackupRepositoriesRepo } from '../../../src/fileBackup/db/repositories/fileBackupRepositoriesRepo.js';
import { createFileBackupTasksRepo } from '../../../src/fileBackup/db/repositories/fileBackupTasksRepo.js';
import { createFileBackupRunsRepo } from '../../../src/fileBackup/db/repositories/fileBackupRunsRepo.js';
import { createFileBackupRetentionDeletionsRepo } from '../../../src/fileBackup/db/repositories/fileBackupRetentionDeletionsRepo.js';
import { createFileBackupMaintenanceRunsRepo } from '../../../src/fileBackup/db/repositories/fileBackupMaintenanceRunsRepo.js';
import { createFakeSecretStore } from '../../helpers/testContext.js';
import { withTempDir } from '../../helpers/tempDir.js';
import { deleteFileBackupRun } from '../../../src/fileBackup/retention/deleteFileBackupRun.js';
import { initRepository, runBackup, listSnapshots } from '../../../src/fileBackup/restic/resticClient.js';

function buildRepos() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrationsSourceDir());
  const transportsRepo = createTransportsRepo(db);
  return {
    db,
    clientsRepo: createClientsRepo(db),
    reposRepo: createFileBackupRepositoriesRepo(db),
    tasksRepo: createFileBackupTasksRepo(db, transportsRepo),
    runsRepo: createFileBackupRunsRepo(db),
    retentionDeletionsRepo: createFileBackupRetentionDeletionsRepo(db),
    maintenanceRunsRepo: createFileBackupMaintenanceRunsRepo(db),
  };
}

describe('deleteFileBackupRun', () => {
  it('throws a clean error for a nonexistent run', async () => {
    const repos = buildRepos();
    await expect(
      deleteFileBackupRun('does-not-exist', {
        fileBackupRunsRepo: repos.runsRepo,
        fileBackupRepositoriesRepo: repos.reposRepo,
        fileBackupRetentionDeletionsRepo: repos.retentionDeletionsRepo,
        fileBackupMaintenanceRunsRepo: repos.maintenanceRunsRepo,
        secretStore: createFakeSecretStore(),
      })
    ).rejects.toThrow(/not found/);
  });

  it('rejects a run with no snapshot to delete', async () => {
    const repos = buildRepos();
    const clientId = repos.clientsRepo.create({ name: 'Acme', localBasePath: 'D:\\Backups\\Acme' }).id;
    const repositoryId = repos.reposRepo.create({ clientId, repoPath: 'D:\\Backups\\Acme\\_restic-repo', passwordSecretRef: 'ref-1' }).id;
    const taskId = repos.tasksRepo.createLocalFolder({ clientId, repositoryId, name: 'Uploads', sourcePath: 'D:\\Sites\\acme\\uploads' }).id;
    const run = repos.runsRepo.create({ taskId, clientId, repositoryId, pid: process.pid });
    repos.runsRepo.markFinished(run.id, 'Failed', { errorMessage: 'boom' }); // never got a snapshot

    await expect(
      deleteFileBackupRun(run.id, {
        fileBackupRunsRepo: repos.runsRepo,
        fileBackupRepositoriesRepo: repos.reposRepo,
        fileBackupRetentionDeletionsRepo: repos.retentionDeletionsRepo,
        fileBackupMaintenanceRunsRepo: repos.maintenanceRunsRepo,
        secretStore: createFakeSecretStore(),
      })
    ).rejects.toThrow(/no snapshot/);
  });

  const hasRestic = Boolean(process.env.RESTIC_PATH);

  it.skipIf(!hasRestic)('forgets exactly the requested snapshot in a real repository, leaving the others intact', async () => {
    await withTempDir(async (root) => {
      const repoPath = join(root, 'repo');
      const sourcePath = join(root, 'source');
      await mkdir(sourcePath, { recursive: true });
      await writeFile(join(sourcePath, 'a.txt'), '1');
      const password = 'test-password';
      await initRepository(repoPath, password);

      const snap1 = (await runBackup(repoPath, password, sourcePath, { tag: 't1' })).snapshotId;
      await writeFile(join(sourcePath, 'a.txt'), '2');
      const snap2 = (await runBackup(repoPath, password, sourcePath, { tag: 't1' })).snapshotId;

      const repos = buildRepos();
      const clientId = repos.clientsRepo.create({ name: 'Acme', localBasePath: root }).id;
      const secretStore = createFakeSecretStore();
      secretStore.set('ref-1', password);
      const repositoryId = repos.reposRepo.create({ clientId, repoPath, passwordSecretRef: 'ref-1' }).id;
      const taskId = repos.tasksRepo.createLocalFolder({ clientId, repositoryId, name: 'Uploads', sourcePath }).id;

      const run1 = repos.runsRepo.create({ taskId, clientId, repositoryId, pid: process.pid });
      repos.runsRepo.recordBackupSummary(run1.id, {
        snapshotId: snap1,
        filesNew: 1, filesChanged: 0, filesUnmodified: 0, filesDeleted: 0, dirsNew: 1, dirsChanged: 0,
        totalFilesProcessed: 1, totalBytesProcessed: 1, dataAdded: 1, dataAddedPacked: 1, warnings: [],
      });
      repos.runsRepo.markFinished(run1.id, 'Success');

      const result = await deleteFileBackupRun(run1.id, {
        fileBackupRunsRepo: repos.runsRepo,
        fileBackupRepositoriesRepo: repos.reposRepo,
        fileBackupRetentionDeletionsRepo: repos.retentionDeletionsRepo,
        fileBackupMaintenanceRunsRepo: repos.maintenanceRunsRepo,
        secretStore,
      });

      expect(result.deleted).toBe(true);
      const remaining = await listSnapshots(repoPath, password);
      expect(remaining.map((s) => s.id)).toEqual([snap2]);

      const deletions = repos.retentionDeletionsRepo.listByTask(taskId);
      expect(deletions).toHaveLength(1);
      expect(deletions[0].forgottenSnapshotId).toBe(snap1);
      expect(deletions[0].reason).toBe('manual_delete');

      // file_backup_runs itself is untouched, matching automated retention's own behavior.
      const run = repos.runsRepo.getById(run1.id);
      expect(run?.status).toBe('Success');
      expect(run?.snapshotId).toBe(snap1);
    });
  }, 60_000);
});
