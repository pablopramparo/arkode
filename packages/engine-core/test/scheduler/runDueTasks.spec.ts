import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runDueTasks } from '../../src/scheduler/runDueTasks.js';
import type { BackupStrategyContext, BackupStrategyExecutor, ProducedDump } from '../../src/strategies/types.js';
import type { RunBackupTaskDeps } from '../../src/orchestrator/runBackupTask.js';
import { createTestContext, type TestContext } from '../helpers/testContext.js';
import { withTempDir } from '../helpers/tempDir.js';

let appDataDir: string;
let previousAppDataDirEnv: string | undefined;

beforeAll(async () => {
  appDataDir = await mkdtemp(join(tmpdir(), 'codebius-rundue-test-'));
  previousAppDataDirEnv = process.env.CODEBIUS_APP_DATA_DIR;
  process.env.CODEBIUS_APP_DATA_DIR = appDataDir;
});

afterAll(async () => {
  if (previousAppDataDirEnv === undefined) delete process.env.CODEBIUS_APP_DATA_DIR;
  else process.env.CODEBIUS_APP_DATA_DIR = previousAppDataDirEnv;
  await rm(appDataDir, { recursive: true, force: true });
});

let sequence = 0;
function createFakeExecutor(onProduce?: () => void): BackupStrategyExecutor {
  return {
    kind: 'fetch_existing',
    async produce(ctx: BackupStrategyContext): Promise<ProducedDump> {
      onProduce?.();
      const fileName = `backup-${++sequence}.dump`;
      const localTempPath = join(ctx.targetDir, `${fileName}.part`);
      await writeFile(localTempPath, 'content');
      return { localTempPath, fileName, sizeBytes: 7, checksumSha256: 'x'.repeat(64) };
    },
  };
}

function buildDeps(ctx: TestContext, executor: BackupStrategyExecutor): RunBackupTaskDeps {
  return {
    clientsRepo: ctx.clientsRepo,
    transportsRepo: ctx.transportsRepo,
    databaseConnectionsRepo: ctx.databaseConnectionsRepo,
    runsRepo: ctx.runsRepo,
    logEventsRepo: ctx.logEventsRepo,
    knownHostsRepo: ctx.knownHostsRepo,
    retentionDeletionsRepo: ctx.retentionDeletionsRepo,
    secretStore: ctx.secretStore,
    resolveExecutorOverride: () => executor,
  };
}

function seedTask(ctx: TestContext, localBasePath: string, scheduleTime: string | null) {
  const client = ctx.clientsRepo.create({ name: `client-${randomSuffix()}`, localBasePath });
  const transport = ctx.transportsRepo.createSftp({
    clientId: client.id,
    name: 'sftp',
    host: 'h',
    username: 'u',
    privateKeyPath: 'k',
  });
  const task = ctx.tasksRepo.createFetchExisting({
    clientId: client.id,
    transportId: transport.id,
    name: 'task',
    dbEngine: 'unknown',
    remotePath: '/backups',
  });
  return scheduleTime ? ctx.tasksRepo.setSchedule(task.id, { scheduleTime, scheduleEnabled: true }) : task;
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

describe('runDueTasks', () => {
  it('runs only the due tasks and skips the rest, reporting both', async () => {
    await withTempDir(async (dir) => {
      const ctx = createTestContext();
      const dueTask = seedTask(ctx, join(dir, 'due'), '03:00');
      const notDueTask = seedTask(ctx, join(dir, 'notdue'), '23:59');

      let produceCalls = 0;
      const executor = createFakeExecutor(() => produceCalls++);
      const now = new Date(2026, 0, 1, 10, 0);

      const results = await runDueTasks([dueTask, notDueTask], buildDeps(ctx, executor), now);

      expect(produceCalls).toBe(1);
      const dueResult = results.find((r) => r.taskId === dueTask.id)!;
      const notDueResult = results.find((r) => r.taskId === notDueTask.id)!;
      expect(dueResult.ran).toBe(true);
      expect(dueResult.result?.run.status).toBe('Success');
      expect(notDueResult.ran).toBe(false);
      expect(notDueResult.result).toBeUndefined();
    });
  });

  it('reports a per-task Failed result when the strategy itself fails, without stopping other tasks', async () => {
    await withTempDir(async (dir) => {
      const ctx = createTestContext();
      const goodTask = seedTask(ctx, join(dir, 'good'), '03:00');
      const brokenTask = seedTask(ctx, join(dir, 'broken'), '03:00');

      const executor = createFakeExecutor();
      const deps: RunBackupTaskDeps = {
        ...buildDeps(ctx, executor),
        resolveExecutorOverride: (task) =>
          task.id === brokenTask.id
            ? {
                kind: 'fetch_existing',
                async produce() {
                  throw new Error('boom');
                },
              }
            : executor,
      };

      const now = new Date(2026, 0, 1, 10, 0);
      const results = await runDueTasks([goodTask, brokenTask], deps, now);

      const goodResult = results.find((r) => r.taskId === goodTask.id)!;
      const brokenResult = results.find((r) => r.taskId === brokenTask.id)!;
      expect(goodResult.result?.run.status).toBe('Success');
      expect(brokenResult.result?.run.status).toBe('Failed');
      expect(brokenResult.error).toBeUndefined(); // runBackupTask handled it internally — a Failed run, not an exception
    });
  });

  it("isolates a task that throws before runBackupTask's own error handling even starts (e.g. a bad client reference)", async () => {
    await withTempDir(async (dir) => {
      const ctx = createTestContext();
      const goodTask = seedTask(ctx, join(dir, 'good'), '03:00');
      const brokenTask = seedTask(ctx, join(dir, 'broken'), '03:00');
      // Simulates data corruption: a task object pointing at a client id
      // that doesn't exist — runBackupTask throws before it ever creates a
      // backup_runs row, so there's no Failed run to report, only an
      // exception runDueTasks itself must catch.
      const brokenTaskWithBadClient = { ...brokenTask, clientId: 'does-not-exist' };

      const executor = createFakeExecutor();
      const now = new Date(2026, 0, 1, 10, 0);
      const results = await runDueTasks([goodTask, brokenTaskWithBadClient], buildDeps(ctx, executor), now);

      const goodResult = results.find((r) => r.taskId === goodTask.id)!;
      const brokenResult = results.find((r) => r.taskId === brokenTask.id)!;
      expect(goodResult.result?.run.status).toBe('Success');
      expect(brokenResult.ran).toBe(true);
      expect(brokenResult.result).toBeUndefined();
      expect(brokenResult.error).toMatch(/not found/i);
    });
  });
});
