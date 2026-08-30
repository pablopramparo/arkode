import { describe, expect, it } from 'vitest';
import { createTestContext } from '../../helpers/testContext.js';

describe('replicationTargetsRepo', () => {
  it('creates a target per (client, content) and reads it back', () => {
    const ctx = createTestContext();
    const client = ctx.clientsRepo.create({ name: 'Winners', localBasePath: 'D:/Backups/Winners' });

    const target = ctx.replicationTargetsRepo.create({
      clientId: client.id,
      content: 'restic_repo',
      remotePath: 'arkode/Winners/repo',
      rcloneConfigSecretRef: 'replication:x:restic_repo:rclone-config',
      encryptWithCrypt: false,
      cryptPasswordSecretRef: null,
    });

    expect(target.clientId).toBe(client.id);
    expect(target.content).toBe('restic_repo');
    expect(target.enabled).toBe(true);
    expect(target.encryptWithCrypt).toBe(false);
    expect(ctx.replicationTargetsRepo.getById(target.id)).toEqual(target);
    expect(ctx.replicationTargetsRepo.getByClientAndContent(client.id, 'restic_repo')?.id).toBe(target.id);
  });

  it('rejects a second target for the same (client, content) but allows the other content kind', () => {
    const ctx = createTestContext();
    const client = ctx.clientsRepo.create({ name: 'W', localBasePath: 'D:/W' });
    const base = {
      clientId: client.id,
      remotePath: 'p',
      rcloneConfigSecretRef: 'r',
      encryptWithCrypt: false,
      cryptPasswordSecretRef: null,
    } as const;

    ctx.replicationTargetsRepo.create({ ...base, content: 'restic_repo' });
    expect(() => ctx.replicationTargetsRepo.create({ ...base, content: 'restic_repo' })).toThrow(/already has/i);
    expect(() => ctx.replicationTargetsRepo.create({ ...base, content: 'db_dumps' })).not.toThrow();
  });

  it('listEnabled() only returns enabled targets of active clients', () => {
    const ctx = createTestContext();
    const a = ctx.clientsRepo.create({ name: 'A', localBasePath: 'D:/A' });
    const b = ctx.clientsRepo.create({ name: 'B', localBasePath: 'D:/B' });
    const mk = (clientId: string, content: 'restic_repo' | 'db_dumps') =>
      ctx.replicationTargetsRepo.create({
        clientId,
        content,
        remotePath: 'p',
        rcloneConfigSecretRef: 'r',
        encryptWithCrypt: false,
        cryptPasswordSecretRef: null,
      });

    const t1 = mk(a.id, 'restic_repo');
    const t2 = mk(a.id, 'db_dumps');
    mk(b.id, 'restic_repo');

    ctx.replicationTargetsRepo.update(t2.id, { enabled: false });
    ctx.clientsRepo.deactivate(b.id);

    const enabled = ctx.replicationTargetsRepo.listEnabled().map((t) => t.id);
    expect(enabled).toEqual([t1.id]);
  });

  it('update() changes remotePath / enabled; recordResult() stamps last_*', () => {
    const ctx = createTestContext();
    const client = ctx.clientsRepo.create({ name: 'W', localBasePath: 'D:/W' });
    const target = ctx.replicationTargetsRepo.create({
      clientId: client.id,
      content: 'restic_repo',
      remotePath: 'old',
      rcloneConfigSecretRef: 'r',
      encryptWithCrypt: false,
      cryptPasswordSecretRef: null,
    });

    ctx.replicationTargetsRepo.update(target.id, { remotePath: 'new', enabled: false });
    let after = ctx.replicationTargetsRepo.getById(target.id)!;
    expect(after.remotePath).toBe('new');
    expect(after.enabled).toBe(false);

    ctx.replicationTargetsRepo.recordResult(target.id, 'Failed', 'boom');
    after = ctx.replicationTargetsRepo.getById(target.id)!;
    expect(after.lastStatus).toBe('Failed');
    expect(after.lastError).toBe('boom');
    expect(after.lastReplicatedAt).not.toBeNull();
  });

  it('remove() deletes the target', () => {
    const ctx = createTestContext();
    const client = ctx.clientsRepo.create({ name: 'W', localBasePath: 'D:/W' });
    const target = ctx.replicationTargetsRepo.create({
      clientId: client.id,
      content: 'db_dumps',
      remotePath: 'p',
      rcloneConfigSecretRef: 'r',
      encryptWithCrypt: true,
      cryptPasswordSecretRef: 'c',
    });
    ctx.replicationTargetsRepo.remove(target.id);
    expect(ctx.replicationTargetsRepo.getById(target.id)).toBeNull();
  });
});
