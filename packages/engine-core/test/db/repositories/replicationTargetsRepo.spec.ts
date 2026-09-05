import { describe, expect, it } from 'vitest';
import { createTestContext } from '../../helpers/testContext.js';

describe('replicationTargetsRepo', () => {
  it('creates a target per (client, content) and reads it back', () => {
    const ctx = createTestContext();
    const client = ctx.clientsRepo.create({ name: 'Winners', localBasePath: 'D:/Backups/Winners' });

    const target = ctx.replicationTargetsRepo.create({
      clientId: client.id,
      content: 'restic_repo',
      provider: 'rclone_drive',
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
      provider: 'rclone_drive',
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
        provider: 'rclone_drive',
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
      provider: 'rclone_drive',
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
      provider: 'rclone_drive',
      remotePath: 'p',
      rcloneConfigSecretRef: 'r',
      encryptWithCrypt: true,
      cryptPasswordSecretRef: 'c',
    });
    ctx.replicationTargetsRepo.remove(target.id);
    expect(ctx.replicationTargetsRepo.getById(target.id)).toBeNull();
  });

  it('creates an rclone_sftp target linked to a transport, with no rcloneConfigSecretRef', () => {
    const ctx = createTestContext();
    const client = ctx.clientsRepo.create({ name: 'W', localBasePath: 'D:/W' });
    const transport = ctx.transportsRepo.createSftp({
      clientId: client.id,
      name: 'Off-site',
      host: 'backup.example.com',
      username: 'arkode',
      privateKeyPath: 'C:/keys/x.key',
    });

    const target = ctx.replicationTargetsRepo.create({
      clientId: client.id,
      content: 'restic_repo',
      provider: 'rclone_sftp',
      remotePath: 'arkode/W/repo',
      transportId: transport.id,
      encryptWithCrypt: false,
      cryptPasswordSecretRef: null,
    });

    expect(target.provider).toBe('rclone_sftp');
    expect(target.transportId).toBe(transport.id);
    expect(target.rcloneConfigSecretRef).toBeNull();
  });

  it('rejects an rclone_sftp target with no transportId, and an rclone_drive target with no rcloneConfigSecretRef', () => {
    const ctx = createTestContext();
    const client = ctx.clientsRepo.create({ name: 'W', localBasePath: 'D:/W' });

    expect(() =>
      ctx.replicationTargetsRepo.create({
        clientId: client.id,
        content: 'restic_repo',
        provider: 'rclone_sftp',
        remotePath: 'p',
        encryptWithCrypt: false,
        cryptPasswordSecretRef: null,
      })
    ).toThrow(/requires transportId/i);

    expect(() =>
      ctx.replicationTargetsRepo.create({
        clientId: client.id,
        content: 'db_dumps',
        provider: 'rclone_drive',
        remotePath: 'p',
        encryptWithCrypt: false,
        cryptPasswordSecretRef: null,
      })
    ).toThrow(/requires rcloneConfigSecretRef/i);
  });

  it('setSftpHostKey() round-trips through getById()', () => {
    const ctx = createTestContext();
    const client = ctx.clientsRepo.create({ name: 'W', localBasePath: 'D:/W' });
    const transport = ctx.transportsRepo.createSftp({
      clientId: client.id,
      name: 'Off-site',
      host: 'backup.example.com',
      username: 'arkode',
      privateKeyPath: 'C:/keys/x.key',
    });
    const target = ctx.replicationTargetsRepo.create({
      clientId: client.id,
      content: 'restic_repo',
      provider: 'rclone_sftp',
      remotePath: 'p',
      transportId: transport.id,
      encryptWithCrypt: false,
      cryptPasswordSecretRef: null,
    });

    expect(target.sftpHostKey).toBeNull();
    ctx.replicationTargetsRepo.setSftpHostKey(
      target.id,
      'backup.example.com ssh-ed25519 AAAA...\n',
      'ssh-ed25519 abc123'
    );

    const after = ctx.replicationTargetsRepo.getById(target.id)!;
    expect(after.sftpHostKey).toBe('backup.example.com ssh-ed25519 AAAA...\n');
    expect(after.sftpHostKeyFingerprint).toBe('ssh-ed25519 abc123');
  });
});
