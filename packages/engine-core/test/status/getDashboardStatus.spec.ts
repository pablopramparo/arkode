import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { getDashboardStatus } from '../../src/status/getDashboardStatus.js';
import { createTestContext, type TestContext } from '../helpers/testContext.js';

function seedTask(ctx: TestContext) {
  const client = ctx.clientsRepo.create({ name: `client-${randomUUID()}`, localBasePath: 'D:/Backups/x' });
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
  return { client, task };
}

function insertRun(
  ctx: TestContext,
  taskId: string,
  clientId: string,
  status: string,
  hoursAgo: number,
  opts: { sizeBytes?: number | null; errorMessage?: string | null } = {}
) {
  const id = randomUUID();
  ctx.db
    .prepare(
      `INSERT INTO backup_runs (id, task_id, client_id, strategy, status, started_at, finished_at, downloaded_at, local_path, size_bytes, error_message, pid)
       VALUES (?, ?, ?, 'fetch_existing', ?, datetime('now', '-' || ? || ' hours'), datetime('now', '-' || ? || ' hours'), datetime('now', '-' || ? || ' hours'), ?, ?, ?, 1)`
    )
    .run(
      id,
      taskId,
      clientId,
      status,
      hoursAgo,
      hoursAgo,
      hoursAgo,
      opts.sizeBytes !== undefined && opts.sizeBytes !== null ? '/fake.dump' : null,
      opts.sizeBytes ?? null,
      opts.errorMessage ?? null
    );
}

function seedFileTask(ctx: TestContext, sourceKind: 'local_folder' | 'remote_folder' = 'local_folder') {
  const client = ctx.clientsRepo.create({ name: `client-${randomUUID()}`, localBasePath: 'D:/Backups/f' });
  const repo = ctx.fileBackupRepositoriesRepo.create({
    clientId: client.id,
    repoPath: 'D:\\Backups\\f\\_restic-repo',
    passwordSecretRef: 'secret:x',
  });
  const task = ctx.fileBackupTasksRepo.createLocalFolder({
    clientId: client.id,
    repositoryId: repo.id,
    name: 'file-task',
    sourcePath: 'D:\\Uploads',
  });
  return { client, repo, task };
}

function insertFileRun(
  ctx: TestContext,
  taskId: string,
  clientId: string,
  repositoryId: string,
  status: string,
  hoursAgo: number,
  opts: { totalBytesProcessed?: number | null; snapshotId?: string | null; errorMessage?: string | null } = {}
) {
  const id = randomUUID();
  ctx.db
    .prepare(
      `INSERT INTO file_backup_runs (id, task_id, client_id, repository_id, status, snapshot_id, total_bytes_processed, started_at, finished_at, error_message, pid)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', '-' || ? || ' hours'), datetime('now', '-' || ? || ' hours'), ?, 1)`
    )
    .run(
      id,
      taskId,
      clientId,
      repositoryId,
      status,
      opts.snapshotId ?? (status === 'Success' ? `snap-${id.slice(0, 8)}` : null),
      opts.totalBytesProcessed ?? null,
      hoursAgo,
      hoursAgo,
      opts.errorMessage ?? null
    );
}

describe('getDashboardStatus', () => {
  it('reports NeverRun for a task with no run history', () => {
    const ctx = createTestContext();
    const { client, task } = seedTask(ctx);

    const rows = getDashboardStatus(ctx);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ client: client.name, task: task.name, status: 'NeverRun', sizeBytes: null });
  });

  it("surfaces the latest attempt's status even when it failed, while still reporting the last real backup's size/age", () => {
    const ctx = createTestContext();
    const { task, client } = seedTask(ctx);
    insertRun(ctx, task.id, client.id, 'Success', 35, { sizeBytes: 1_258_291_200 });
    insertRun(ctx, task.id, client.id, 'Failed', 2, { sizeBytes: null, errorMessage: 'ECONNREFUSED 10.0.0.5:22' });

    const rows = getDashboardStatus(ctx);

    expect(rows[0].status).toBe('Failed'); // the fresh failure must be visible, not hidden behind the old success
    expect(rows[0].sizeBytes).toBe(1_258_291_200); // but the last real backup's data is still surfaced
    expect(rows[0].lastGoodBackupAt).not.toBeNull();
    expect(rows[0].latestErrorMessage).toBe('ECONNREFUSED 10.0.0.5:22');
  });

  it('reports a healthy Success task with matching size and recent lastGoodBackupAt', () => {
    const ctx = createTestContext();
    const { task, client } = seedTask(ctx);
    insertRun(ctx, task.id, client.id, 'Success', 11, { sizeBytes: 148_897_792 });

    const rows = getDashboardStatus(ctx);

    expect(rows[0].status).toBe('Success');
    expect(rows[0].sizeBytes).toBe(148_897_792);
    expect(rows[0].latestErrorMessage).toBeNull();
  });

  it('only includes tasks belonging to active clients', () => {
    const ctx = createTestContext();
    const { client } = seedTask(ctx);
    ctx.db.prepare('UPDATE clients SET is_active = 0 WHERE id = ?').run(client.id);

    expect(getDashboardStatus(ctx)).toHaveLength(0);
  });

  it('excludes a deactivated task even though its client is still active', () => {
    // Real bug, reported directly: Tareas.tsx and the ficha de cliente both
    // correctly hid a deactivated task, but the Dashboard kept showing it
    // forever -- listByClient() (used by getDashboardStatus, unlike the
    // other two screens) never filtered by is_active at all.
    const ctx = createTestContext();
    const { client, task } = seedTask(ctx);
    ctx.tasksRepo.deactivate(task.id);

    expect(getDashboardStatus(ctx)).toHaveLength(0);
  });

  it('includes file-backup tasks alongside DB tasks, tagged with kind', () => {
    const ctx = createTestContext();
    const { task } = seedFileTask(ctx);

    const rows = getDashboardStatus(ctx);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'file',
      task: task.name,
      strategy: 'local_folder',
      status: 'NeverRun',
      sizeBytes: null,
      checksumSha256: null,
    });
  });

  it("surfaces a file task's latest failure while still reporting the last successful snapshot's size/age", () => {
    const ctx = createTestContext();
    const { task, client, repo } = seedFileTask(ctx);
    insertFileRun(ctx, task.id, client.id, repo.id, 'Success', 30, { totalBytesProcessed: 5_000_000 });
    insertFileRun(ctx, task.id, client.id, repo.id, 'Failed', 1, { errorMessage: 'restic: repository is already locked' });

    const rows = getDashboardStatus(ctx);

    expect(rows[0].status).toBe('Failed');
    expect(rows[0].sizeBytes).toBe(5_000_000);
    expect(rows[0].lastGoodBackupAt).not.toBeNull();
    expect(rows[0].latestErrorMessage).toBe('restic: repository is already locked');
  });

  it('excludes a deactivated file-backup task', () => {
    const ctx = createTestContext();
    const { task } = seedFileTask(ctx);
    ctx.fileBackupTasksRepo.deactivate(task.id);

    expect(getDashboardStatus(ctx)).toHaveLength(0);
  });
});
