import { randomUUID } from 'node:crypto';
import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyRetention, resolveRetentionPolicy, type RetentionPolicy } from '../../src/retention/applyRetention.js';
import type { RunLogger } from '../../src/logging/logger.js';
import { createTestContext, type TestContext } from '../helpers/testContext.js';
import { withTempDir } from '../helpers/tempDir.js';

function createSilentLogger(): RunLogger {
  return { filePath: 'fake', log: () => {} };
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

interface SeedRunOptions {
  status?: 'Success' | 'Warning' | 'Failed';
  localPath?: string | null;
  sizeBytes?: number | null;
  downloadedAt?: string | null;
}

/**
 * Inserts a backup_runs row directly, bypassing the orchestrator's own
 * state machine — retention only cares about the columns it reads
 * (status, local_path, downloaded_at, size_bytes), so this keeps the test
 * setup focused on retention's own contract rather than re-deriving a full
 * download pipeline for every scenario.
 */
function seedRun(ctx: TestContext, taskId: string, clientId: string, opts: SeedRunOptions = {}): string {
  const id = randomUUID();
  const downloadedAt = opts.downloadedAt === undefined ? new Date().toISOString() : opts.downloadedAt;
  ctx.db
    .prepare(
      `INSERT INTO backup_runs (id, task_id, client_id, strategy, status, started_at, downloaded_at, local_path, size_bytes, pid)
       VALUES (@id, @taskId, @clientId, 'fetch_existing', @status, @startedAt, @downloadedAt, @localPath, @sizeBytes, 1)`
    )
    .run({
      id,
      taskId,
      clientId,
      status: opts.status ?? 'Success',
      startedAt: downloadedAt ?? new Date().toISOString(),
      downloadedAt,
      localPath: opts.localPath === undefined ? null : opts.localPath,
      sizeBytes: opts.sizeBytes === undefined ? null : opts.sizeBytes,
    });
  return id;
}

function seedClientAndTask(ctx: TestContext, policy: Partial<{ retentionCount: number; retentionDays: number }> = {}) {
  const client = ctx.clientsRepo.create({
    name: 'Winners',
    localBasePath: 'D:/Backups/Winners',
    retentionCount: policy.retentionCount ?? null,
    retentionDays: policy.retentionDays ?? null,
  });
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

async function run(ctx: TestContext, taskId: string, policy: RetentionPolicy): Promise<void> {
  const task = ctx.tasksRepo.getById(taskId);
  if (!task) throw new Error('task not found');
  await applyRetention(task, policy, {
    runsRepo: ctx.runsRepo,
    retentionDeletionsRepo: ctx.retentionDeletionsRepo,
    logger: createSilentLogger(),
    triggeredByRunId: null,
  });
}

describe('applyRetention', () => {
  it('does nothing when no policy is configured', async () => {
    await withTempDir(async (dir) => {
      const ctx = createTestContext();
      const { client, task } = seedClientAndTask(ctx);
      const path = join(dir, 'a.dump');
      await writeFile(path, 'x');
      seedRun(ctx, task.id, client.id, { localPath: path });
      seedRun(ctx, task.id, client.id, { localPath: path });

      await run(ctx, task.id, resolveRetentionPolicy(client, task));

      expect(ctx.retentionDeletionsRepo.listByTask(task.id)).toEqual([]);
      await expect(access(path)).resolves.toBeUndefined();
    });
  });

  it('keeps only the newest N Success backups under a count policy', async () => {
    await withTempDir(async (dir) => {
      const ctx = createTestContext();
      const { client, task } = seedClientAndTask(ctx, { retentionCount: 2 });

      const paths: string[] = [];
      for (let i = 0; i < 4; i++) {
        const path = join(dir, `backup-${i}.dump`);
        await writeFile(path, 'x');
        paths.push(path);
        // Oldest first (i=0) to newest last (i=3), with distinct timestamps.
        seedRun(ctx, task.id, client.id, { localPath: path, downloadedAt: isoDaysAgo(4 - i) });
      }

      await run(ctx, task.id, resolveRetentionPolicy(client, task));

      const deletions = ctx.retentionDeletionsRepo.listByTask(task.id);
      expect(deletions).toHaveLength(2);
      expect(deletions.every((d) => d.reason === 'retention_count_exceeded')).toBe(true);

      // The two newest survive; the two oldest are gone from disk.
      await expect(access(paths[3])).resolves.toBeUndefined();
      await expect(access(paths[2])).resolves.toBeUndefined();
      await expect(access(paths[1])).rejects.toThrow();
      await expect(access(paths[0])).rejects.toThrow();
    });
  });

  it('deletes only backups older than the configured number of days', async () => {
    await withTempDir(async (dir) => {
      const ctx = createTestContext();
      const { client, task } = seedClientAndTask(ctx, { retentionDays: 5 });

      const newPath = join(dir, 'new.dump');
      const oldPath = join(dir, 'old.dump');
      await writeFile(newPath, 'x');
      await writeFile(oldPath, 'x');
      seedRun(ctx, task.id, client.id, { localPath: newPath, downloadedAt: isoDaysAgo(1) });
      seedRun(ctx, task.id, client.id, { localPath: oldPath, downloadedAt: isoDaysAgo(10) });

      await run(ctx, task.id, resolveRetentionPolicy(client, task));

      const deletions = ctx.retentionDeletionsRepo.listByTask(task.id);
      expect(deletions).toHaveLength(1);
      expect(deletions[0].reason).toBe('retention_days_exceeded');
      await expect(access(newPath)).resolves.toBeUndefined();
      await expect(access(oldPath)).rejects.toThrow();
    });
  });

  it('when both count and days are configured, only deletes a backup that violates both', async () => {
    await withTempDir(async (dir) => {
      const ctx = createTestContext();
      const { client, task } = seedClientAndTask(ctx, { retentionCount: 1, retentionDays: 30 });

      // Violates count (rank 1, beyond the newest 1) but NOT days (recent) — must survive.
      const recentButBeyondCount = join(dir, 'recent.dump');
      await writeFile(recentButBeyondCount, 'x');
      seedRun(ctx, task.id, client.id, { localPath: recentButBeyondCount, downloadedAt: isoDaysAgo(2) });

      // Newest — never touched regardless of policy.
      const newest = join(dir, 'newest.dump');
      await writeFile(newest, 'x');
      seedRun(ctx, task.id, client.id, { localPath: newest, downloadedAt: isoDaysAgo(1) });

      await run(ctx, task.id, resolveRetentionPolicy(client, task));

      // Combining policies must never be MORE aggressive than either alone.
      expect(ctx.retentionDeletionsRepo.listByTask(task.id)).toEqual([]);
      await expect(access(recentButBeyondCount)).resolves.toBeUndefined();
      await expect(access(newest)).resolves.toBeUndefined();
    });
  });

  it('never deletes the only remaining Success backup, even under an aggressive policy', async () => {
    await withTempDir(async (dir) => {
      const ctx = createTestContext();
      const { client, task } = seedClientAndTask(ctx, { retentionDays: 1 });

      const onlyBackup = join(dir, 'only.dump');
      await writeFile(onlyBackup, 'x');
      seedRun(ctx, task.id, client.id, { localPath: onlyBackup, downloadedAt: isoDaysAgo(365) });

      await run(ctx, task.id, resolveRetentionPolicy(client, task));

      expect(ctx.retentionDeletionsRepo.listByTask(task.id)).toEqual([]);
      await expect(access(onlyBackup)).resolves.toBeUndefined();
    });
  });

  it('regression: a no-op Success run (no local_path) must never occupy the protected "newest" slot', async () => {
    // This is the exact scenario that broke the survivor-floor invariant
    // during manual testing: fetch_existing's "already up to date" no-op
    // Success runs (local_path IS NULL) were being counted as kept-backup
    // slots. Being always the newest, a no-op run "protected" nothing while
    // pushing the one real backup into prunable territory, and it got
    // deleted — leaving zero real backups.
    await withTempDir(async (dir) => {
      const ctx = createTestContext();
      const { client, task } = seedClientAndTask(ctx, { retentionDays: 1 });

      const onlyRealBackup = join(dir, 'only.dump');
      await writeFile(onlyRealBackup, 'x');
      seedRun(ctx, task.id, client.id, { localPath: onlyRealBackup, downloadedAt: isoDaysAgo(365) });

      // Several no-op Success runs, all newer than the real backup, exactly
      // as fetch_existing produces when there's nothing new to download.
      seedRun(ctx, task.id, client.id, { localPath: null, sizeBytes: null, downloadedAt: null });
      seedRun(ctx, task.id, client.id, { localPath: null, sizeBytes: null, downloadedAt: null });
      seedRun(ctx, task.id, client.id, { localPath: null, sizeBytes: null, downloadedAt: null });

      await run(ctx, task.id, resolveRetentionPolicy(client, task));

      expect(ctx.retentionDeletionsRepo.listByTask(task.id)).toEqual([]);
      await expect(access(onlyRealBackup)).resolves.toBeUndefined();
    });
  });

  it('regression: never re-processes (or duplicates a deletion record for) an already-deleted run', async () => {
    await withTempDir(async (dir) => {
      const ctx = createTestContext();
      const { client, task } = seedClientAndTask(ctx, { retentionCount: 1 });

      const oldPath = join(dir, 'old.dump');
      const newPath = join(dir, 'new.dump');
      await writeFile(oldPath, 'x');
      await writeFile(newPath, 'x');
      seedRun(ctx, task.id, client.id, { localPath: oldPath, downloadedAt: isoDaysAgo(2) });
      seedRun(ctx, task.id, client.id, { localPath: newPath, downloadedAt: isoDaysAgo(1) });

      const policy = resolveRetentionPolicy(client, task);
      await run(ctx, task.id, policy);
      await run(ctx, task.id, policy);
      await run(ctx, task.id, policy);

      const deletions = ctx.retentionDeletionsRepo.listByTask(task.id);
      expect(deletions).toHaveLength(1); // not 3
    });
  });

  it('records a deletion even if the file was already missing on disk (ENOENT)', async () => {
    await withTempDir(async (dir) => {
      const ctx = createTestContext();
      const { client, task } = seedClientAndTask(ctx, { retentionCount: 1 });

      const missingPath = join(dir, 'never-actually-written.dump');
      const newPath = join(dir, 'new.dump');
      await writeFile(newPath, 'x');
      seedRun(ctx, task.id, client.id, { localPath: missingPath, downloadedAt: isoDaysAgo(2) });
      seedRun(ctx, task.id, client.id, { localPath: newPath, downloadedAt: isoDaysAgo(1) });

      await run(ctx, task.id, resolveRetentionPolicy(client, task));

      const deletions = ctx.retentionDeletionsRepo.listByTask(task.id);
      expect(deletions).toHaveLength(1);
      expect(deletions[0].localPath).toBe(missingPath);
    });
  });

  it('never touches Warning-status backups', async () => {
    await withTempDir(async (dir) => {
      const ctx = createTestContext();
      const { client, task } = seedClientAndTask(ctx, { retentionCount: 1 });

      const warningPath = join(dir, 'warning.dump');
      const newestPath = join(dir, 'newest.dump');
      await writeFile(warningPath, 'x');
      await writeFile(newestPath, 'x');
      seedRun(ctx, task.id, client.id, { status: 'Warning', localPath: warningPath, downloadedAt: isoDaysAgo(5) });
      seedRun(ctx, task.id, client.id, { status: 'Success', localPath: newestPath, downloadedAt: isoDaysAgo(1) });

      await run(ctx, task.id, resolveRetentionPolicy(client, task));

      expect(ctx.retentionDeletionsRepo.listByTask(task.id)).toEqual([]);
      await expect(access(warningPath)).resolves.toBeUndefined();
    });
  });
});
