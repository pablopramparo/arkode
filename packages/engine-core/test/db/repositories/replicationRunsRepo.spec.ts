import { describe, expect, it } from 'vitest';
import { createTestContext } from '../../helpers/testContext.js';

function seedTarget(ctx: ReturnType<typeof createTestContext>) {
  const client = ctx.clientsRepo.create({ name: 'W', localBasePath: 'D:/W' });
  const target = ctx.replicationTargetsRepo.create({
    clientId: client.id,
    content: 'restic_repo',
    provider: 'rclone_drive',
    remotePath: 'p',
    rcloneConfigSecretRef: 'r',
    encryptWithCrypt: false,
    cryptPasswordSecretRef: null,
  });
  return { client, target };
}

describe('replicationRunsRepo', () => {
  it('create() opens a Running row; markFinished() records stats + status', () => {
    const ctx = createTestContext();
    const { client, target } = seedTarget(ctx);

    const run = ctx.replicationRunsRepo.create({ targetId: target.id, clientId: client.id, trigger: 'manual', pid: 123 });
    expect(run.status).toBe('Running');
    expect(run.pid).toBe(123);
    expect(ctx.replicationRunsRepo.listInProgressByTarget(target.id).map((r) => r.id)).toEqual([run.id]);

    ctx.replicationRunsRepo.markFinished(run.id, 'Success', {
      bytesTransferred: 4096,
      filesTransferred: 3,
      filesDeleted: 1,
    });
    const done = ctx.replicationRunsRepo.getById(run.id)!;
    expect(done.status).toBe('Success');
    expect(done.bytesTransferred).toBe(4096);
    expect(done.filesTransferred).toBe(3);
    expect(done.filesDeleted).toBe(1);
    expect(done.finishedAt).not.toBeNull();
    expect(ctx.replicationRunsRepo.listInProgressByTarget(target.id)).toEqual([]);
  });

  it('markFinished() Failed carries the error message', () => {
    const ctx = createTestContext();
    const { client, target } = seedTarget(ctx);
    const run = ctx.replicationRunsRepo.create({ targetId: target.id, clientId: client.id, trigger: 'scheduled', pid: 1 });
    ctx.replicationRunsRepo.markFinished(run.id, 'Failed', { errorMessage: 'rclone sync failed: quota exceeded' });
    expect(ctx.replicationRunsRepo.getById(run.id)!.errorMessage).toMatch(/quota exceeded/);
  });

  it('listRecent() is newest-first and filterable by target', () => {
    const ctx = createTestContext();
    const { client, target } = seedTarget(ctx);
    const other = ctx.replicationTargetsRepo.create({
      clientId: client.id,
      content: 'db_dumps',
      provider: 'rclone_drive',
      remotePath: 'p2',
      rcloneConfigSecretRef: 'r2',
      encryptWithCrypt: false,
      cryptPasswordSecretRef: null,
    });
    const r1 = ctx.replicationRunsRepo.create({ targetId: target.id, clientId: client.id, trigger: 'manual', pid: 1 });
    const r2 = ctx.replicationRunsRepo.create({ targetId: target.id, clientId: client.id, trigger: 'manual', pid: 2 });
    ctx.replicationRunsRepo.create({ targetId: other.id, clientId: client.id, trigger: 'manual', pid: 3 });

    const forTarget = ctx.replicationRunsRepo.listRecent({ targetId: target.id }).map((r) => r.id);
    expect(forTarget).toEqual([r2.id, r1.id]);
    expect(ctx.replicationRunsRepo.listRecent({}).length).toBe(3);
  });
});
