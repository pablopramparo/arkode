import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../helpers/testContext.js';

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

function insertRun(ctx: TestContext, taskId: string, clientId: string, status: string, hoursAgo: number) {
  const id = randomUUID();
  ctx.db
    .prepare(
      `INSERT INTO backup_runs (id, task_id, client_id, strategy, status, started_at, finished_at, pid)
       VALUES (?, ?, ?, 'fetch_existing', ?, datetime('now', '-' || ? || ' hours'), datetime('now', '-' || ? || ' hours'), 1)`
    )
    .run(id, taskId, clientId, status, hoursAgo, hoursAgo);
  return id;
}

function insertRunWithFile(ctx: TestContext, taskId: string, clientId: string, status: string, hoursAgo: number, localPath = '/x/backup.dump') {
  const id = randomUUID();
  ctx.db
    .prepare(
      `INSERT INTO backup_runs (id, task_id, client_id, strategy, status, started_at, finished_at, local_path, pid)
       VALUES (?, ?, ?, 'fetch_existing', ?, datetime('now', '-' || ? || ' hours'), datetime('now', '-' || ? || ' hours'), ?, 1)`
    )
    .run(id, taskId, clientId, status, hoursAgo, hoursAgo, localPath);
  return id;
}

describe('runsRepo.listBackups', () => {
  it('only returns Success/Warning runs that have a file on disk', () => {
    const ctx = createTestContext();
    const { task, client } = seedTask(ctx);
    insertRun(ctx, task.id, client.id, 'Failed', 3);
    insertRun(ctx, task.id, client.id, 'Success', 2); // no-op success, no file
    const withFile = insertRunWithFile(ctx, task.id, client.id, 'Success', 1);

    const { runs, total } = ctx.runsRepo.listBackups({ clientId: client.id });

    expect(runs.map((r) => r.id)).toEqual([withFile]);
    expect(total).toBe(1);
  });

  it('includes Warning runs with a file, not just Success', () => {
    const ctx = createTestContext();
    const { task, client } = seedTask(ctx);
    const warningWithFile = insertRunWithFile(ctx, task.id, client.id, 'Warning', 1);

    const { runs } = ctx.runsRepo.listBackups({ clientId: client.id });

    expect(runs.map((r) => r.id)).toEqual([warningWithFile]);
  });

  it('returns newest first', () => {
    const ctx = createTestContext();
    const { task, client } = seedTask(ctx);
    const older = insertRunWithFile(ctx, task.id, client.id, 'Success', 10);
    const newer = insertRunWithFile(ctx, task.id, client.id, 'Success', 1);

    const { runs } = ctx.runsRepo.listBackups({ clientId: client.id });

    expect(runs.map((r) => r.id)).toEqual([newer, older]);
  });

  it('filters by taskId within a client', () => {
    const ctx = createTestContext();
    const { task: taskA, client } = seedTask(ctx);
    const { task: taskB } = seedTask(ctx);
    const fromA = insertRunWithFile(ctx, taskA.id, client.id, 'Success', 1);
    insertRunWithFile(ctx, taskB.id, client.id, 'Success', 1);

    const { runs } = ctx.runsRepo.listBackups({ clientId: client.id, taskId: taskA.id });

    expect(runs.map((r) => r.id)).toEqual([fromA]);
  });

  it('paginates with limit/offset and reports the total independent of the page', () => {
    const ctx = createTestContext();
    const { task, client } = seedTask(ctx);
    for (let i = 0; i < 5; i++) insertRunWithFile(ctx, task.id, client.id, 'Success', i);

    const page = ctx.runsRepo.listBackups({ clientId: client.id, limit: 2, offset: 2 });

    expect(page.runs).toHaveLength(2);
    expect(page.total).toBe(5);
  });
});

describe('runsRepo.listRecent', () => {
  it('returns runs newest first', () => {
    const ctx = createTestContext();
    const { task, client } = seedTask(ctx);
    const older = insertRun(ctx, task.id, client.id, 'Success', 10);
    const newer = insertRun(ctx, task.id, client.id, 'Failed', 1);

    const rows = ctx.runsRepo.listRecent();

    expect(rows.map((r) => r.id)).toEqual([newer, older]);
  });

  it('filters by taskId', () => {
    const ctx = createTestContext();
    const { task: taskA, client } = seedTask(ctx);
    const { task: taskB } = seedTask(ctx);
    insertRun(ctx, taskA.id, client.id, 'Success', 1);
    insertRun(ctx, taskB.id, client.id, 'Success', 2);

    const rows = ctx.runsRepo.listRecent({ taskId: taskA.id });

    expect(rows).toHaveLength(1);
    expect(rows[0].taskId).toBe(taskA.id);
  });

  it('filters by clientId', () => {
    const ctx = createTestContext();
    const { task: taskA, client: clientA } = seedTask(ctx);
    const { task: taskB, client: clientB } = seedTask(ctx);
    insertRun(ctx, taskA.id, clientA.id, 'Success', 1);
    insertRun(ctx, taskB.id, clientB.id, 'Success', 2);

    const rows = ctx.runsRepo.listRecent({ clientId: clientA.id });

    expect(rows).toHaveLength(1);
    expect(rows[0].clientId).toBe(clientA.id);
  });

  it('caps results at the given limit', () => {
    const ctx = createTestContext();
    const { task, client } = seedTask(ctx);
    for (let i = 0; i < 5; i++) insertRun(ctx, task.id, client.id, 'Success', i);

    const rows = ctx.runsRepo.listRecent({ limit: 2 });

    expect(rows).toHaveLength(2);
  });

  it('defaults to a 200-row cap when no limit is given', () => {
    const ctx = createTestContext();
    const { task, client } = seedTask(ctx);
    insertRun(ctx, task.id, client.id, 'Success', 1);

    const rows = ctx.runsRepo.listRecent();

    expect(rows.length).toBeLessThanOrEqual(200);
  });
});
