import { randomUUID } from 'node:crypto';
import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deleteBackupRun } from '../../src/retention/deleteBackupRun.js';
import { createTestContext, type TestContext } from '../helpers/testContext.js';
import { withTempDir } from '../helpers/tempDir.js';

interface SeedRunOptions {
  status?: 'Pending' | 'Running' | 'Producing' | 'Validating' | 'Success' | 'Warning' | 'Failed';
  localPath?: string | null;
  sizeBytes?: number | null;
}

/** Inserts a backup_runs row directly, bypassing the orchestrator's state machine — mirrors applyRetention.spec.ts's own seedRun helper. */
function seedRun(ctx: TestContext, taskId: string, clientId: string, opts: SeedRunOptions = {}): string {
  const id = randomUUID();
  const now = new Date().toISOString();
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
      startedAt: now,
      downloadedAt: now,
      localPath: opts.localPath === undefined ? null : opts.localPath,
      sizeBytes: opts.sizeBytes === undefined ? null : opts.sizeBytes,
    });
  return id;
}

function seedClientAndTask(ctx: TestContext) {
  const client = ctx.clientsRepo.create({ name: 'Winners', localBasePath: 'D:/Backups/Winners' });
  const transport = ctx.transportsRepo.createSftp({ clientId: client.id, name: 'sftp', host: 'h', username: 'u', privateKeyPath: 'k' });
  const task = ctx.tasksRepo.createFetchExisting({
    clientId: client.id,
    transportId: transport.id,
    name: 'task',
    dbEngine: 'unknown',
    remotePath: '/backups',
  });
  return { client, task };
}

function deps(ctx: TestContext) {
  return { runsRepo: ctx.runsRepo, retentionDeletionsRepo: ctx.retentionDeletionsRepo };
}

describe('deleteBackupRun', () => {
  it('deletes the file on disk and records a manual_delete deletion, leaving the run row untouched', async () => {
    await withTempDir(async (dir) => {
      const ctx = createTestContext();
      const { client, task } = seedClientAndTask(ctx);
      const localPath = join(dir, 'backup.dump');
      await writeFile(localPath, 'real backup content');
      const runId = seedRun(ctx, task.id, client.id, { localPath, sizeBytes: 20 });

      const result = await deleteBackupRun(runId, deps(ctx));

      expect(result.deleted).toBe(true);
      await expect(access(localPath)).rejects.toThrow();

      const run = ctx.runsRepo.getById(runId);
      expect(run?.status).toBe('Success'); // untouched
      expect(run?.localPath).toBe(localPath); // untouched — same behavior automated retention has

      const deletions = ctx.retentionDeletionsRepo.listByTask(task.id);
      expect(deletions).toHaveLength(1);
      expect(deletions[0].reason).toBe('manual_delete');
      expect(deletions[0].deletedBackupRunId).toBe(runId);
      expect(deletions[0].triggeredByRunId).toBeNull();
    });
  });

  it('still records a deletion when the file is already missing on disk (ENOENT)', async () => {
    const ctx = createTestContext();
    const { client, task } = seedClientAndTask(ctx);
    const runId = seedRun(ctx, task.id, client.id, { localPath: 'D:/Backups/Winners/gone.dump' });

    const result = await deleteBackupRun(runId, deps(ctx));

    expect(result.deleted).toBe(true);
    expect(ctx.retentionDeletionsRepo.listByTask(task.id)).toHaveLength(1);
  });

  it('rejects deleting a run that is still in progress', async () => {
    const ctx = createTestContext();
    const { client, task } = seedClientAndTask(ctx);
    const runId = seedRun(ctx, task.id, client.id, { status: 'Producing', localPath: 'D:/x.dump' });

    await expect(deleteBackupRun(runId, deps(ctx))).rejects.toThrow(/still in progress/);
  });

  it('rejects deleting a run with no local file', async () => {
    const ctx = createTestContext();
    const { client, task } = seedClientAndTask(ctx);
    const runId = seedRun(ctx, task.id, client.id, { status: 'Failed', localPath: null });

    await expect(deleteBackupRun(runId, deps(ctx))).rejects.toThrow(/no local file/);
  });

  it('throws a clean error for a nonexistent run', async () => {
    const ctx = createTestContext();
    await expect(deleteBackupRun('does-not-exist', deps(ctx))).rejects.toThrow(/not found/);
  });
});
