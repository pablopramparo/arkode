import { describe, expect, it } from 'vitest';
import { runSchedulerTick, SCHEDULER_HEARTBEAT_KEY, type RunSchedulerTickDeps } from '../../src/scheduler/runSchedulerTick.js';
import { createTestContext, type TestContext } from '../helpers/testContext.js';

function tickDeps(ctx: TestContext): RunSchedulerTickDeps {
  return {
    tasksRepo: ctx.tasksRepo,
    fileBackupTasksRepo: ctx.fileBackupTasksRepo,
    settingsRepo: ctx.settingsRepo,
    dbTaskDeps: {
      clientsRepo: ctx.clientsRepo,
      transportsRepo: ctx.transportsRepo,
      databaseConnectionsRepo: ctx.databaseConnectionsRepo,
      runsRepo: ctx.runsRepo,
      logEventsRepo: ctx.logEventsRepo,
      knownHostsRepo: ctx.knownHostsRepo,
      retentionDeletionsRepo: ctx.retentionDeletionsRepo,
      settingsRepo: ctx.settingsRepo,
      secretStore: ctx.secretStore,
      onUnknownHost: async () => false,
    },
    fileTaskDeps: {
      clientsRepo: ctx.clientsRepo,
      transportsRepo: ctx.transportsRepo,
      knownHostsRepo: ctx.knownHostsRepo,
      fileBackupRepositoriesRepo: ctx.fileBackupRepositoriesRepo,
      fileBackupRunsRepo: ctx.fileBackupRunsRepo,
      fileBackupMaintenanceRunsRepo: ctx.fileBackupMaintenanceRunsRepo,
      fileBackupRetentionDeletionsRepo: ctx.fileBackupRetentionDeletionsRepo,
      fileBackupLogEventsRepo: ctx.fileBackupLogEventsRepo,
      secretStore: ctx.secretStore,
      onUnknownHost: async () => false,
    },
    maintenanceDeps: {
      fileBackupRepositoriesRepo: ctx.fileBackupRepositoriesRepo,
      fileBackupMaintenanceRunsRepo: ctx.fileBackupMaintenanceRunsRepo,
      fileBackupRunsRepo: ctx.fileBackupRunsRepo,
      secretStore: ctx.secretStore,
    },
    replicationTargetsRepo: ctx.replicationTargetsRepo,
    replicationDeps: {
      replicationTargetsRepo: ctx.replicationTargetsRepo,
      replicationRunsRepo: ctx.replicationRunsRepo,
      clientsRepo: ctx.clientsRepo,
      fileBackupRepositoriesRepo: ctx.fileBackupRepositoriesRepo,
      fileBackupRunsRepo: ctx.fileBackupRunsRepo,
      fileBackupMaintenanceRunsRepo: ctx.fileBackupMaintenanceRunsRepo,
      secretStore: ctx.secretStore,
      runsRepo: ctx.runsRepo,
      preflightOverride: async () => {},
      rcloneOverride: {
        withRcloneConfig: async (_t, _s, fn) => fn('/tmp/c.conf', 'drive'),
        sync: async () => ({ bytesTransferred: 1, filesTransferred: 1, filesDeleted: 0, warnings: [] }),
      },
    },
  };
}

describe('runSchedulerTick', () => {
  it('stamps the heartbeat and returns empty phase summaries when nothing is scheduled', async () => {
    const ctx = createTestContext();
    const now = new Date('2026-08-30T12:00:00.000Z');

    const result = await runSchedulerTick(tickDeps(ctx), now);

    expect(ctx.settingsRepo.get(SCHEDULER_HEARTBEAT_KEY)).toBe(now.toISOString());
    expect(result.at).toBe(now.toISOString());
    expect(result.db).toEqual({ ran: 0, failed: 0, errors: [] });
    expect(result.file).toEqual({ ran: 0, failed: 0, errors: [] });
    expect(result.maintenance).toEqual({ ran: 0, failed: 0, errors: [] });
    expect(result.replication).toEqual({ ran: 0, failed: 0, errors: [] });
    expect(result.phaseErrors).toEqual([]);
  });

  it('runs a due replication target in the replication phase (after backups + maintenance)', async () => {
    const ctx = createTestContext();
    const now = new Date('2026-08-30T12:00:00.000Z');
    const client = ctx.clientsRepo.create({ name: 'W', localBasePath: 'D:/Backups/W' });
    const repo = ctx.fileBackupRepositoriesRepo.create({
      clientId: client.id,
      repoPath: 'D:/Backups/W/_restic-repo',
      passwordSecretRef: 'repo:pw',
    });
    ctx.fileBackupRepositoriesRepo.markInitialized(repo.id, 'rid');
    ctx.secretStore.set('repo:pw', 'k');
    const target = ctx.replicationTargetsRepo.create({
      clientId: client.id,
      content: 'restic_repo',
      remotePath: 'arkode/W/repo',
      rcloneConfigSecretRef: 'repl:cfg',
      encryptWithCrypt: false,
      cryptPasswordSecretRef: null,
    });
    ctx.secretStore.set('repl:cfg', JSON.stringify({ token: '{"access_token":"a"}' }));

    const result = await runSchedulerTick(tickDeps(ctx), now);

    expect(result.replication).toEqual({ ran: 1, failed: 0, errors: [] });
    expect(ctx.replicationTargetsRepo.getById(target.id)!.lastStatus).toBe('Success');
  });

  it('isolates a thrown phase — records it in phaseErrors, still runs the rest, still stamps the heartbeat', async () => {
    const ctx = createTestContext();
    const now = new Date('2026-08-30T13:00:00.000Z');
    const deps = tickDeps(ctx);
    // Make the DB-backup phase blow up before any per-task isolation can catch it.
    deps.tasksRepo = {
      ...deps.tasksRepo,
      listScheduled: () => {
        throw new Error('boom: listScheduled failed');
      },
    } as typeof deps.tasksRepo;

    const result = await runSchedulerTick(deps, now);

    expect(result.phaseErrors).toHaveLength(1);
    expect(result.phaseErrors[0]).toMatch(/db-backup phase.*boom/i);
    expect(result.file).toEqual({ ran: 0, failed: 0, errors: [] }); // still ran
    expect(result.maintenance).toEqual({ ran: 0, failed: 0, errors: [] }); // still ran
    expect(ctx.settingsRepo.get(SCHEDULER_HEARTBEAT_KEY)).toBe(now.toISOString()); // still stamped
  });
});
