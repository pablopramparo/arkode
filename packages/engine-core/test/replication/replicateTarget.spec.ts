import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestContext, type TestContext } from '../helpers/testContext.js';
import { replicateTarget, type RcloneOps } from '../../src/replication/replicateTarget.js';
import type { ReplicateTargetDeps } from '../../src/replication/replicateTarget.js';

const TOKEN = '{"access_token":"a","refresh_token":"r","expiry":"2026-01-01T00:00:00Z"}';

function deps(ctx: TestContext, over: Partial<ReplicateTargetDeps> = {}): ReplicateTargetDeps {
  return {
    replicationTargetsRepo: ctx.replicationTargetsRepo,
    replicationRunsRepo: ctx.replicationRunsRepo,
    clientsRepo: ctx.clientsRepo,
    fileBackupRepositoriesRepo: ctx.fileBackupRepositoriesRepo,
    fileBackupRunsRepo: ctx.fileBackupRunsRepo,
    fileBackupMaintenanceRunsRepo: ctx.fileBackupMaintenanceRunsRepo,
    secretStore: ctx.secretStore,
    preflightOverride: async () => {},
    ...over,
  };
}

function fakeRclone(syncImpl?: RcloneOps['sync']): { ops: RcloneOps; sync: ReturnType<typeof vi.fn> } {
  const sync = vi.fn(
    syncImpl ??
      (async () => ({ bytesTransferred: 100, filesTransferred: 2, filesDeleted: 0, warnings: [] as string[] }))
  );
  return {
    sync,
    ops: {
      withRcloneConfig: async (_t, _s, fn) => fn('/tmp/fake-rclone.conf', 'drive'),
      sync: sync as unknown as RcloneOps['sync'],
    },
  };
}

/** A client + an initialized restic repo + a rclone-authorized restic_repo target. */
function seedResticTarget(ctx: TestContext) {
  const client = ctx.clientsRepo.create({ name: 'Winners', localBasePath: 'D:/Backups/Winners' });
  const repo = ctx.fileBackupRepositoriesRepo.create({
    clientId: client.id,
    repoPath: 'D:/Backups/Winners/_restic-repo',
    passwordSecretRef: 'repo:pw',
  });
  ctx.fileBackupRepositoriesRepo.markInitialized(repo.id, 'restic-repo-id');
  ctx.secretStore.set('repo:pw', 'recovery-key');
  const target = ctx.replicationTargetsRepo.create({
    clientId: client.id,
    content: 'restic_repo',
    remotePath: 'arkode/Winners/repo',
    rcloneConfigSecretRef: 'repl:cfg',
    encryptWithCrypt: false,
    cryptPasswordSecretRef: null,
  });
  ctx.secretStore.set('repl:cfg', JSON.stringify({ token: TOKEN }));
  return { client, repo, target };
}

const tempDirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
});

describe('replicateTarget', () => {
  it('happy path: syncs, records a Success run + target status', async () => {
    const ctx = createTestContext();
    const { target } = seedResticTarget(ctx);
    const { ops, sync } = fakeRclone();

    const result = await replicateTarget(deps(ctx, { rcloneOverride: ops }), target.id, { trigger: 'manual' });

    expect(result.status).toBe('Success');
    expect(result.bytesTransferred).toBe(100);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(sync.mock.calls[0][0]).toMatchObject({ source: 'D:/Backups/Winners/_restic-repo', remotePath: 'arkode/Winners/repo' });

    const runs = ctx.replicationRunsRepo.listRecent({ targetId: target.id });
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('Success');
    expect(ctx.replicationTargetsRepo.getById(target.id)!.lastStatus).toBe('Success');
  });

  it('rclone failure -> Failed run + Failed target status, no throw', async () => {
    const ctx = createTestContext();
    const { target } = seedResticTarget(ctx);
    const { ops } = fakeRclone(async () => {
      throw new Error('rclone sync failed: quota exceeded');
    });

    const result = await replicateTarget(deps(ctx, { rcloneOverride: ops }), target.id, { trigger: 'scheduled' });

    expect(result.status).toBe('Failed');
    expect(result.message).toMatch(/quota exceeded/);
    expect(ctx.replicationRunsRepo.getById(result.runId!)!.status).toBe('Failed');
    expect(ctx.replicationTargetsRepo.getById(target.id)!.lastStatus).toBe('Failed');
  });

  it('rclone warnings -> Warning status', async () => {
    const ctx = createTestContext();
    const { target } = seedResticTarget(ctx);
    const { ops } = fakeRclone(async () => ({
      bytesTransferred: 10,
      filesTransferred: 1,
      filesDeleted: 0,
      warnings: ['could not read one file'],
    }));

    const result = await replicateTarget(deps(ctx, { rcloneOverride: ops }), target.id, { trigger: 'manual' });
    expect(result.status).toBe('Warning');
    expect(ctx.replicationTargetsRepo.getById(target.id)!.lastStatus).toBe('Warning');
  });

  it('a disabled target is skipped without creating a run', async () => {
    const ctx = createTestContext();
    const { target } = seedResticTarget(ctx);
    ctx.replicationTargetsRepo.update(target.id, { enabled: false });
    const { ops, sync } = fakeRclone();

    const result = await replicateTarget(deps(ctx, { rcloneOverride: ops }), target.id, { trigger: 'manual' });
    expect(result).toMatchObject({ ran: false, status: 'Skipped' });
    expect(sync).not.toHaveBeenCalled();
    expect(ctx.replicationRunsRepo.listRecent({ targetId: target.id })).toHaveLength(0);
  });

  it('skips when the repository is busy (a live maintenance run holds the lock)', async () => {
    const ctx = createTestContext();
    const { repo, target } = seedResticTarget(ctx);
    // pid = this process -> "alive" and recent -> not stale -> real lock.
    ctx.fileBackupMaintenanceRunsRepo.create({ repositoryId: repo.id, operation: 'prune', pid: process.pid });
    const { ops, sync } = fakeRclone();

    const result = await replicateTarget(deps(ctx, { rcloneOverride: ops }), target.id, { trigger: 'scheduled' });
    expect(result).toMatchObject({ ran: false, status: 'Skipped' });
    expect(sync).not.toHaveBeenCalled();
  });

  it('an unauthorized target fails immediately with a clear message', async () => {
    const ctx = createTestContext();
    const { target } = seedResticTarget(ctx);
    ctx.secretStore.delete('repl:cfg');
    const { ops, sync } = fakeRclone();

    const result = await replicateTarget(deps(ctx, { rcloneOverride: ops }), target.id, { trigger: 'manual' });
    expect(result.status).toBe('Failed');
    expect(result.message).toMatch(/not authorized/i);
    expect(sync).not.toHaveBeenCalled();
  });

  it('db_dumps target syncs localBasePath with _restic-repo excluded', async () => {
    const ctx = createTestContext();
    const dir = mkdtempSync(join(tmpdir(), 'arkode-repl-dumps-'));
    tempDirs.push(dir);
    const client = ctx.clientsRepo.create({ name: 'W', localBasePath: dir });
    const target = ctx.replicationTargetsRepo.create({
      clientId: client.id,
      content: 'db_dumps',
      remotePath: 'arkode/W/dumps',
      rcloneConfigSecretRef: 'repl:cfg2',
      encryptWithCrypt: true,
      cryptPasswordSecretRef: 'repl:crypt2',
    });
    ctx.secretStore.set('repl:cfg2', JSON.stringify({ token: TOKEN }));
    ctx.secretStore.set('repl:crypt2', 'a-strong-crypt-pw');
    const { ops, sync } = fakeRclone();

    const result = await replicateTarget(deps(ctx, { rcloneOverride: ops }), target.id, { trigger: 'manual' });

    expect(result.status).toBe('Success');
    const call = sync.mock.calls[0][0];
    expect(call.source).toBe(dir);
    expect(call.extraArgs).toEqual(expect.arrayContaining(['--exclude', '_restic-repo/**']));
  });
});
