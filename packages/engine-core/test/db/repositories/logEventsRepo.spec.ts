import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../helpers/testContext.js';

function seedRunId(ctx: TestContext): string {
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
  const run = ctx.runsRepo.create({ taskId: task.id, clientId: client.id, strategy: 'fetch_existing', transportId: transport.id, databaseConnectionId: null, pid: 1 });
  return run.id;
}

describe('logEventsRepo', () => {
  it('returns events newest first', () => {
    const ctx = createTestContext();
    const runId = seedRunId(ctx);
    ctx.logEventsRepo.append(runId, 'info', 'connect', 'first');
    ctx.logEventsRepo.append(runId, 'info', 'download', 'second');

    const { events } = ctx.logEventsRepo.listRecent();

    expect(events.map((e) => e.message)).toEqual(['second', 'first']);
  });

  it('filters by a case-sensitive-agnostic search term against the message', () => {
    const ctx = createTestContext();
    const runId = seedRunId(ctx);
    ctx.logEventsRepo.append(runId, 'error', 'validate', 'Validation failed: empty file');
    ctx.logEventsRepo.append(runId, 'info', 'result', 'Backup succeeded');

    const { events } = ctx.logEventsRepo.listRecent({ search: 'failed' });

    expect(events).toHaveLength(1);
    expect(events[0].message).toContain('Validation failed');
  });

  it('filters by step', () => {
    const ctx = createTestContext();
    const runId = seedRunId(ctx);
    ctx.logEventsRepo.append(runId, 'info', 'connect', 'connecting');
    ctx.logEventsRepo.append(runId, 'info', 'download', 'downloading');

    const { events } = ctx.logEventsRepo.listRecent({ step: 'download' });

    expect(events).toHaveLength(1);
    expect(events[0].step).toBe('download');
  });

  it('filters by level', () => {
    const ctx = createTestContext();
    const runId = seedRunId(ctx);
    ctx.logEventsRepo.append(runId, 'error', 'result', 'oops');
    ctx.logEventsRepo.append(runId, 'info', 'result', 'fine');

    const { events } = ctx.logEventsRepo.listRecent({ level: 'error' });

    expect(events).toHaveLength(1);
    expect(events[0].level).toBe('error');
  });

  it('paginates with limit/offset while total reflects the full filtered count', () => {
    const ctx = createTestContext();
    const runId = seedRunId(ctx);
    for (let i = 0; i < 5; i++) ctx.logEventsRepo.append(runId, 'info', 'connect', `line ${i}`);

    const page = ctx.logEventsRepo.listRecent({ limit: 2, offset: 0 });

    expect(page.events).toHaveLength(2);
    expect(page.total).toBe(5);
  });

  it('listDistinctSteps returns every step that has ever been logged, sorted', () => {
    const ctx = createTestContext();
    const runId = seedRunId(ctx);
    ctx.logEventsRepo.append(runId, 'info', 'download', 'x');
    ctx.logEventsRepo.append(runId, 'info', 'connect', 'y');
    ctx.logEventsRepo.append(runId, 'info', 'connect', 'z');

    expect(ctx.logEventsRepo.listDistinctSteps()).toEqual(['connect', 'download']);
  });
});
