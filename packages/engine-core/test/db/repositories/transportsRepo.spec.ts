import { describe, expect, it } from 'vitest';
import { createTestContext } from '../../helpers/testContext.js';

function seedClient(ctx: ReturnType<typeof createTestContext>) {
  return ctx.clientsRepo.create({ name: 'Winners', localBasePath: 'D:/Backups/Winners' });
}

describe('transportsRepo', () => {
  it('updates only the fields provided, leaving type-specific fields for the other type untouched', () => {
    const ctx = createTestContext();
    const client = seedClient(ctx);
    const transport = ctx.transportsRepo.createSftp({
      clientId: client.id,
      name: 'sftp',
      host: 'h1',
      username: 'u1',
      privateKeyPath: 'k1',
      remotePath: '/backups',
    });

    const updated = ctx.transportsRepo.update(transport.id, { host: 'h2' });

    expect(updated.host).toBe('h2');
    expect(updated.username).toBe('u1'); // untouched
    expect(updated.remotePath).toBe('/backups'); // untouched
    expect(updated.type).toBe('sftp'); // update() has no way to change this
  });

  it('allows explicitly clearing a nullable field by passing null', () => {
    const ctx = createTestContext();
    const client = seedClient(ctx);
    const transport = ctx.transportsRepo.createSftp({
      clientId: client.id,
      name: 'sftp',
      host: 'h',
      username: 'u',
      privateKeyPath: 'k',
      remotePath: '/backups',
      remoteFilePattern: '.*\\.dump',
    });

    const updated = ctx.transportsRepo.update(transport.id, { remoteFilePattern: null });

    expect(updated.remoteFilePattern).toBeNull();
  });

  it('throws a clean error when updating a nonexistent transport', () => {
    const ctx = createTestContext();
    expect(() => ctx.transportsRepo.update('nonexistent', { host: 'x' })).toThrow(/not found/i);
  });

  it('deactivate() flips is_active without deleting the row', () => {
    const ctx = createTestContext();
    const client = seedClient(ctx);
    const transport = ctx.transportsRepo.createSftp({
      clientId: client.id,
      name: 'sftp',
      host: 'h',
      username: 'u',
      privateKeyPath: 'k',
      remotePath: '/backups',
    });

    ctx.transportsRepo.deactivate(transport.id);

    expect(ctx.transportsRepo.getById(transport.id)).toMatchObject({ isActive: false });
  });

  it('throws a clean error when deactivating a nonexistent transport', () => {
    const ctx = createTestContext();
    expect(() => ctx.transportsRepo.deactivate('nonexistent')).toThrow(/not found/i);
  });

  it('reactivate() restores is_active after deactivate()', () => {
    const ctx = createTestContext();
    const client = seedClient(ctx);
    const transport = ctx.transportsRepo.createSftp({
      clientId: client.id,
      name: 'sftp',
      host: 'h',
      username: 'u',
      privateKeyPath: 'k',
      remotePath: '/backups',
    });
    ctx.transportsRepo.deactivate(transport.id);

    ctx.transportsRepo.reactivate(transport.id);

    expect(ctx.transportsRepo.getById(transport.id)).toMatchObject({ isActive: true });
  });

  it('throws a clean error when reactivating a nonexistent transport', () => {
    const ctx = createTestContext();
    expect(() => ctx.transportsRepo.reactivate('nonexistent')).toThrow(/not found/i);
  });
});
