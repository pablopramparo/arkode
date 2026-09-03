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

function insertRunWithTrigger(
  ctx: TestContext,
  taskId: string,
  clientId: string,
  trigger: 'manual' | 'scheduled',
  hoursAgo: number
) {
  const id = randomUUID();
  ctx.db
    .prepare(
      `INSERT INTO backup_runs (id, task_id, client_id, strategy, status, trigger, started_at, finished_at, pid)
       VALUES (?, ?, ?, 'fetch_existing', 'Success', ?, datetime('now', '-' || ? || ' hours'), datetime('now', '-' || ? || ' hours'), 1)`
    )
    .run(id, taskId, clientId, trigger, hoursAgo, hoursAgo);
  return id;
}

describe('runsRepo.getLatestScheduledByTask', () => {
  it('returns the newest run with trigger = scheduled, ignoring manual runs entirely', () => {
    const ctx = createTestContext();
    const { task, client } = seedTask(ctx);
    insertRunWithTrigger(ctx, task.id, client.id, 'scheduled', 30);
    const newerScheduled = insertRunWithTrigger(ctx, task.id, client.id, 'scheduled', 10);
    insertRunWithTrigger(ctx, task.id, client.id, 'manual', 1); // most recent overall, but manual

    const latest = ctx.runsRepo.getLatestScheduledByTask(task.id);

    expect(latest?.id).toBe(newerScheduled);
    expect(latest?.trigger).toBe('scheduled');
  });

  it('returns null when the task has only ever had manual runs', () => {
    const ctx = createTestContext();
    const { task, client } = seedTask(ctx);
    insertRunWithTrigger(ctx, task.id, client.id, 'manual', 2);
    insertRunWithTrigger(ctx, task.id, client.id, 'manual', 1);

    expect(ctx.runsRepo.getLatestScheduledByTask(task.id)).toBeNull();
  });

  it("defaults a run created without an explicit trigger to 'manual'", () => {
    const ctx = createTestContext();
    const { task, client } = seedTask(ctx);
    const run = ctx.runsRepo.create({
      taskId: task.id,
      clientId: client.id,
      strategy: 'fetch_existing',
      transportId: null,
      databaseConnectionId: null,
      pid: 1,
    });
    expect(run.trigger).toBe('manual');
    expect(ctx.runsRepo.getLatestScheduledByTask(task.id)).toBeNull();
  });
});

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

describe('runsRepo.updateProgress', () => {
  function makeRun(ctx: TestContext) {
    const { task, client } = seedTask(ctx);
    return ctx.runsRepo.create({
      taskId: task.id,
      clientId: client.id,
      strategy: 'fetch_existing',
      transportId: null,
      databaseConnectionId: null,
      pid: process.pid,
    });
  }

  it('round-trips a progress blob through the JSON column', () => {
    const ctx = createTestContext();
    const run = makeRun(ctx);

    ctx.runsRepo.updateProgress(run.id, {
      phase: 'downloading',
      label: 'Descargando…',
      fraction: 0.42,
      current: 420,
      total: 1000,
      unit: 'bytes',
      updatedAt: '2026-09-03T12:00:00.000Z',
    });

    const read = ctx.runsRepo.getById(run.id);
    expect(read?.progress).toEqual({
      phase: 'downloading',
      label: 'Descargando…',
      fraction: 0.42,
      current: 420,
      total: 1000,
      unit: 'bytes',
      updatedAt: '2026-09-03T12:00:00.000Z',
    });
  });

  it('clears the blob when passed null, and leaves status untouched', () => {
    const ctx = createTestContext();
    const run = makeRun(ctx);
    ctx.runsRepo.updateProgress(run.id, { phase: 'connecting', label: 'x', fraction: null, updatedAt: 'now' });

    ctx.runsRepo.updateProgress(run.id, null);

    const read = ctx.runsRepo.getById(run.id);
    expect(read?.progress).toBeNull();
    expect(read?.status).toBe('Running'); // create() sets Running — updateProgress never touches it
  });

  it('a fresh run has null progress', () => {
    const ctx = createTestContext();
    expect(makeRun(ctx).progress).toBeNull();
  });
});
