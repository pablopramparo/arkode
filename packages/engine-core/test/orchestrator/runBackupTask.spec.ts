import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runBackupTask, type RunBackupTaskDeps } from '../../src/orchestrator/runBackupTask.js';
import { NoNewDumpAvailableError, type BackupStrategyExecutor, type BackupStrategyContext, type ProducedDump } from '../../src/strategies/types.js';
import { createTestContext, type TestContext } from '../helpers/testContext.js';
import { withTempDir } from '../helpers/tempDir.js';

// runBackupTask logs via createRunLogger(), which resolves a real file path
// under appDataDir() (normally %APPDATA%\CodebiusBackupManager). Redirect it
// to a throwaway temp dir for the whole suite so tests never touch the
// real app-data location.
let appDataDir: string;
let previousAppDataDirEnv: string | undefined;

beforeAll(async () => {
  appDataDir = await mkdtemp(join(tmpdir(), 'codebius-orchestrator-test-'));
  previousAppDataDirEnv = process.env.CODEBIUS_APP_DATA_DIR;
  process.env.CODEBIUS_APP_DATA_DIR = appDataDir;
});

afterAll(async () => {
  if (previousAppDataDirEnv === undefined) delete process.env.CODEBIUS_APP_DATA_DIR;
  else process.env.CODEBIUS_APP_DATA_DIR = previousAppDataDirEnv;
  await rm(appDataDir, { recursive: true, force: true });
});

function seedClientAndTask(ctx: TestContext, localBasePath: string) {
  const client = ctx.clientsRepo.create({ name: 'Winners', localBasePath });
  const transport = ctx.transportsRepo.createSftp({
    clientId: client.id,
    name: 'sftp',
    host: 'h',
    username: 'u',
    privateKeyPath: 'k',
    remotePath: '/backups',
  });
  const task = ctx.tasksRepo.createFetchExisting({
    clientId: client.id,
    transportId: transport.id,
    name: 'task',
    dbEngine: 'unknown',
  });
  return { client, task };
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

let fakeExecutorSequence = 0;

/**
 * A fake strategy executor that writes real bytes to a real `.part` file,
 * like a real one would. Each call gets a distinct filename (like a real
 * executor naturally would, from a distinct remote filename/timestamp) —
 * reusing one across calls would make an unrelated later run's retention
 * deletion collide with an earlier run's file of the same name.
 */
function createFakeExecutor(opts: {
  content?: string;
  provideChecksum?: boolean;
  onProduce?: () => void;
}): BackupStrategyExecutor {
  const content = opts.content ?? 'fake backup content';
  return {
    kind: 'fetch_existing',
    async produce(ctx: BackupStrategyContext): Promise<ProducedDump> {
      opts.onProduce?.();
      const fileName = `fake-backup-${++fakeExecutorSequence}.dump`;
      const localTempPath = join(ctx.targetDir, `${fileName}.part`);
      await writeFile(localTempPath, content);
      const dump: ProducedDump = {
        localTempPath,
        fileName,
        sizeBytes: Buffer.byteLength(content),
        sourceModifiedAt: new Date(),
      };
      if (opts.provideChecksum) {
        dump.checksumSha256 = createHash('sha256').update(content).digest('hex');
      }
      return dump;
    },
  };
}

function createThrowingExecutor(error: Error): BackupStrategyExecutor {
  return {
    kind: 'fetch_existing',
    async produce(): Promise<ProducedDump> {
      throw error;
    },
  };
}

describe('runBackupTask', () => {
  it('succeeds, renames off .part, and records size/checksum/local path', async () => {
    await withTempDir(async (dir) => {
      const ctx = createTestContext();
      const { task } = seedClientAndTask(ctx, dir);
      const executor = createFakeExecutor({ content: 'hello backup', provideChecksum: true });

      const result = await runBackupTask(task, buildDeps(ctx, executor));

      expect(result.skipped).toBe(false);
      expect(result.run.status).toBe('Success');
      expect(result.run.sizeBytes).toBe(Buffer.byteLength('hello backup'));
      expect(result.run.checksumSha256).toBe(createHash('sha256').update('hello backup').digest('hex'));
      expect(result.run.localPath).not.toMatch(/\.part$/);
      const fileContent = await readFile(result.run.localPath!, 'utf8');
      expect(fileContent).toBe('hello backup');
    });
  });

  it('falls back to hashing the file itself when the strategy does not provide a checksum', async () => {
    await withTempDir(async (dir) => {
      const ctx = createTestContext();
      const { task } = seedClientAndTask(ctx, dir);
      const executor = createFakeExecutor({ content: 'no checksum provided', provideChecksum: false });

      const result = await runBackupTask(task, buildDeps(ctx, executor));

      expect(result.run.status).toBe('Success');
      expect(result.run.checksumSha256).toBe(createHash('sha256').update('no checksum provided').digest('hex'));
    });
  });

  it('treats "no new dump available" as a successful, skipped no-op — not a Failed run', async () => {
    await withTempDir(async (dir) => {
      const ctx = createTestContext();
      const { task } = seedClientAndTask(ctx, dir);
      const executor = createThrowingExecutor(new NoNewDumpAvailableError('already up to date'));

      const result = await runBackupTask(task, buildDeps(ctx, executor));

      expect(result.skipped).toBe(true);
      expect(result.run.status).toBe('Success');
      expect(result.run.localPath).toBeNull();
    });
  });

  it('marks the run Failed when the strategy throws', async () => {
    await withTempDir(async (dir) => {
      const ctx = createTestContext();
      const { task } = seedClientAndTask(ctx, dir);
      const executor = createThrowingExecutor(new Error('connection refused'));

      const result = await runBackupTask(task, buildDeps(ctx, executor));

      expect(result.run.status).toBe('Failed');
      expect(result.run.errorMessage).toBe('connection refused');
    });
  });

  it('fails the run when the produced file is empty', async () => {
    await withTempDir(async (dir) => {
      const ctx = createTestContext();
      const { task } = seedClientAndTask(ctx, dir);
      const executor = createFakeExecutor({ content: '' });

      const result = await runBackupTask(task, buildDeps(ctx, executor));

      expect(result.run.status).toBe('Failed');
      expect(result.run.errorMessage).toMatch(/empty/i);
    });
  });

  it('fails the run when validation fails (postgres dbEngine without PG_RESTORE_PATH configured)', async () => {
    await withTempDir(async (dir) => {
      const ctx = createTestContext();
      const client = ctx.clientsRepo.create({ name: 'Winners', localBasePath: dir });
      const transport = ctx.transportsRepo.createSftp({
        clientId: client.id,
        name: 'sftp',
        host: 'h',
        username: 'u',
        privateKeyPath: 'k',
        remotePath: '/backups',
      });
      const task = ctx.tasksRepo.createFetchExisting({
        clientId: client.id,
        transportId: transport.id,
        name: 'task',
        dbEngine: 'postgres',
      });
      const originalPgRestorePath = process.env.PG_RESTORE_PATH;
      delete process.env.PG_RESTORE_PATH;
      try {
        const executor = createFakeExecutor({ content: 'not really a pg dump' });
        const result = await runBackupTask(task, buildDeps(ctx, executor));
        expect(result.run.status).toBe('Failed');
        expect(result.run.errorMessage).toMatch(/PG_RESTORE_PATH/);
      } finally {
        if (originalPgRestorePath !== undefined) process.env.PG_RESTORE_PATH = originalPgRestorePath;
      }
    });
  });

  it('skips rather than double-running when a run for the task is genuinely still in progress', async () => {
    await withTempDir(async (dir) => {
      const ctx = createTestContext();
      const { task } = seedClientAndTask(ctx, dir);

      // A live pid — this test process itself is certainly alive.
      const inProgressRun = ctx.runsRepo.create({
        taskId: task.id,
        clientId: task.clientId,
        strategy: task.strategy,
        transportId: task.transportId,
        databaseConnectionId: task.databaseConnectionId,
        pid: process.pid,
      });

      let produceCalls = 0;
      const executor = createFakeExecutor({ onProduce: () => produceCalls++ });

      const result = await runBackupTask(task, buildDeps(ctx, executor));

      expect(result.skipped).toBe(true);
      expect(result.run.id).toBe(inProgressRun.id);
      expect(produceCalls).toBe(0); // never even attempted a new run
    });
  });

  it('recovers a stale in-progress run (dead pid) as Failed, then proceeds normally', async () => {
    await withTempDir(async (dir) => {
      const ctx = createTestContext();
      const { task } = seedClientAndTask(ctx, dir);

      const staleRun = ctx.runsRepo.create({
        taskId: task.id,
        clientId: task.clientId,
        strategy: task.strategy,
        transportId: task.transportId,
        databaseConnectionId: task.databaseConnectionId,
        pid: 999_999, // astronomically unlikely to be a live pid
      });

      const executor = createFakeExecutor({ content: 'fresh backup' });
      const result = await runBackupTask(task, buildDeps(ctx, executor));

      expect(result.run.id).not.toBe(staleRun.id);
      expect(result.run.status).toBe('Success');
      const recoveredStaleRun = ctx.runsRepo.getById(staleRun.id);
      expect(recoveredStaleRun?.status).toBe('Failed');
      expect(recoveredStaleRun?.errorMessage).toMatch(/interrupted/i);
    });
  });

  it('cleans up an orphaned .part file left behind by a previous interrupted run', async () => {
    await withTempDir(async (dir) => {
      const ctx = createTestContext();
      const { client, task } = seedClientAndTask(ctx, dir);

      // Mirrors the orchestrator's private resolveTargetDir(): localBasePath /
      // slugify(task.name) / YYYY / MM. task.name is 'task', which slugifies
      // to itself, so this is safe to hardcode for this focused test.
      const now = new Date();
      const targetDir = join(
        client.localBasePath,
        'task',
        String(now.getUTCFullYear()),
        String(now.getUTCMonth() + 1).padStart(2, '0')
      );
      await mkdir(targetDir, { recursive: true });
      const orphanedPartPath = join(targetDir, 'orphaned.dump.part');
      await writeFile(orphanedPartPath, 'leftover');
      const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
      await utimes(orphanedPartPath, oldTime, oldTime);

      const executor = createFakeExecutor({ content: 'fresh backup' });
      await runBackupTask(task, buildDeps(ctx, executor));

      await expect(readFile(orphanedPartPath)).rejects.toThrow();
    });
  });

  it('applies retention after a run completes, even though the run itself is unrelated to the policy check', async () => {
    await withTempDir(async (dir) => {
      const ctx = createTestContext();
      const client = ctx.clientsRepo.create({ name: 'Winners', localBasePath: dir, retentionCount: 1 });
      const transport = ctx.transportsRepo.createSftp({
        clientId: client.id,
        name: 'sftp',
        host: 'h',
        username: 'u',
        privateKeyPath: 'k',
        remotePath: '/backups',
      });
      const task = ctx.tasksRepo.createFetchExisting({
        clientId: client.id,
        transportId: transport.id,
        name: 'task',
        dbEngine: 'unknown',
      });

      // First backup.
      await runBackupTask(task, buildDeps(ctx, createFakeExecutor({ content: 'first' })));
      // Second backup — with retention_count=1, the first should be pruned afterward.
      const secondResult = await runBackupTask(task, buildDeps(ctx, createFakeExecutor({ content: 'second' })));

      expect(secondResult.run.status).toBe('Success');
      const deletions = ctx.retentionDeletionsRepo.listByTask(task.id);
      expect(deletions).toHaveLength(1);
      await expect(readFile(secondResult.run.localPath!, 'utf8')).resolves.toBe('second');
    });
  });
});
