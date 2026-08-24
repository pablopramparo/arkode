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
});
