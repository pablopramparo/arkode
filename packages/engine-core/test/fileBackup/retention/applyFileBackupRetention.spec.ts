import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { withTempDir } from '../../helpers/tempDir.js';
import { createFakeSecretStore } from '../../helpers/testContext.js';
import {
  applyFileBackupRetention,
  resolveFileBackupRetentionPolicy,
} from '../../../src/fileBackup/retention/applyFileBackupRetention.js';
import { initRepository, runBackup } from '../../../src/fileBackup/restic/resticClient.js';
import type { FileBackupRunLogger } from '../../../src/fileBackup/logging/createFileBackupRunLogger.js';
import type { FileBackupRepository, FileBackupTask } from '../../../src/fileBackup/types.js';
import type { FileBackupRetentionDeletionsRepo } from '../../../src/fileBackup/db/repositories/fileBackupRetentionDeletionsRepo.js';
import type { Client } from '../../../src/types.js';

function fakeLogger(): FileBackupRunLogger {
  return { filePath: 'nowhere', log: () => {} };
}

function makeClient(overrides: Partial<Client> = {}): Client {
  return {
    id: 'c1',
    name: 'Acme',
    description: null,
    isActive: true,
    localBasePath: 'D:\\Backups\\Acme',
    retentionCount: null,
    retentionDays: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeTask(overrides: Partial<FileBackupTask> = {}): FileBackupTask {
  return {
    id: 't1',
    clientId: 'c1',
    repositoryId: 'r1',
    name: 'Uploads',
    sourceKind: 'local_folder',
    sourcePath: 'D:\\Sites\\acme\\uploads',
    transportId: null,
    remoteSourcePath: null,
    retentionCount: null,
    retentionDays: null,
    scheduleTime: null,
    scheduleEnabled: true,
    scheduleFrequency: 'daily',
    scheduleDaysOfWeek: null,
    scheduleDayOfMonth: null,
    isActive: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('resolveFileBackupRetentionPolicy', () => {
  it('task-level overrides client-level; neither set means no retention', () => {
    const client = makeClient({ retentionCount: 10, retentionDays: 30 });
    expect(resolveFileBackupRetentionPolicy(client, makeTask())).toEqual({ count: 10, days: 30 });
    expect(resolveFileBackupRetentionPolicy(client, makeTask({ retentionCount: 3 }))).toEqual({ count: 3, days: 30 });
    expect(resolveFileBackupRetentionPolicy(makeClient(), makeTask())).toEqual({ count: null, days: null });
  });
});

describe('applyFileBackupRetention', () => {
  it('does nothing when no policy is configured', async () => {
    let created = 0;
    const fakeDeletionsRepo = { create: () => { created++; return {} as never; }, listByTask: () => [] } as unknown as FileBackupRetentionDeletionsRepo;
    const repository: FileBackupRepository = {
      id: 'r1', clientId: 'c1', repoPath: 'D:\\repo', passwordSecretRef: 'ref',
      resticRepoId: null, lastPrunedAt: null, lastCheckedAt: null, initializedAt: null,
      createdAt: '', updatedAt: '',
    };
    await applyFileBackupRetention(makeTask(), repository, 'D:\\Sites\\acme\\uploads', { count: null, days: null }, {
      fileBackupRetentionDeletionsRepo: fakeDeletionsRepo,
      secretStore: createFakeSecretStore(),
      logger: fakeLogger(),
      triggeredByRunId: null,
    });
    expect(created).toBe(0);
  });

  const hasRestic = Boolean(process.env.RESTIC_PATH);

  it.skipIf(!hasRestic)('runs forget against a real repository and records every forgotten snapshot', async () => {
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
      await writeFile(join(sourcePath, 'a.txt'), '3');
      await runBackup(repoPath, password, sourcePath, { tag: 't1' }); // 3rd snapshot, kept by --keep-last 1

      const recorded: Array<{ forgottenSnapshotId: string }> = [];
      const fakeDeletionsRepo = {
        create: (input: { forgottenSnapshotId: string }) => {
          recorded.push(input);
          return {} as never;
        },
        listByTask: () => [],
      } as unknown as FileBackupRetentionDeletionsRepo;

      const secretStore = createFakeSecretStore();
      secretStore.set('ref', password);

      const repository: FileBackupRepository = {
        id: 'r1', clientId: 'c1', repoPath, passwordSecretRef: 'ref',
        resticRepoId: null, lastPrunedAt: null, lastCheckedAt: null, initializedAt: '2026-01-01T00:00:00.000Z',
        createdAt: '', updatedAt: '',
      };

      await applyFileBackupRetention(makeTask({ sourcePath }), repository, sourcePath, { count: 1, days: null }, {
        fileBackupRetentionDeletionsRepo: fakeDeletionsRepo,
        secretStore,
        logger: fakeLogger(),
        triggeredByRunId: null,
      });

      expect(recorded.map((r) => r.forgottenSnapshotId).sort()).toEqual([snap1, snap2].sort());
    });
  }, 60_000);
});
