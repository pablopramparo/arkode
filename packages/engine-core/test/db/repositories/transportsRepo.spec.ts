import { describe, expect, it } from 'vitest';
import { createTestContext } from '../../helpers/testContext.js';

function seedClient(ctx: ReturnType<typeof createTestContext>) {
  return ctx.clientsRepo.create({ name: 'Winners', localBasePath: 'D:/Backups/Winners' });
}

describe('transportsRepo', () => {
  it('updates only the fields provided, leaving other fields untouched', () => {
    const ctx = createTestContext();
    const client = seedClient(ctx);
    const transport = ctx.transportsRepo.createSftp({
      clientId: client.id,
      name: 'sftp',
      host: 'h1',
      username: 'u1',
      privateKeyPath: 'k1',
    });

    const updated = ctx.transportsRepo.update(transport.id, { host: 'h2' });

    expect(updated.host).toBe('h2');
    expect(updated.username).toBe('u1'); // untouched
    expect(updated.privateKeyPath).toBe('k1'); // untouched
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
      passphraseSecretRef: 'transport:passphrase:secret-ref-1',
    });

    const updated = ctx.transportsRepo.update(transport.id, { passphraseSecretRef: null });

    expect(updated.passphraseSecretRef).toBeNull();
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
    });
    ctx.transportsRepo.deactivate(transport.id);

    ctx.transportsRepo.reactivate(transport.id);

    expect(ctx.transportsRepo.getById(transport.id)).toMatchObject({ isActive: true });
  });

  it('throws a clean error when reactivating a nonexistent transport', () => {
    const ctx = createTestContext();
    expect(() => ctx.transportsRepo.reactivate('nonexistent')).toThrow(/not found/i);
  });

  it('createFtp() creates a transport with no private key, distinct from sftp/ssh', () => {
    const ctx = createTestContext();
    const client = seedClient(ctx);

    const transport = ctx.transportsRepo.createFtp({
      clientId: client.id,
      name: 'ftp',
      host: 'h',
      username: 'u',
    });

    expect(transport.type).toBe('ftp');
    expect(transport.privateKeyPath).toBeNull();
    expect(transport.port).toBe(21); // ftp's own default, distinct from sftp/ssh's 22
  });

  it('createFtp() round-trips passwordSecretRef', () => {
    const ctx = createTestContext();
    const client = seedClient(ctx);

    const transport = ctx.transportsRepo.createFtp({
      clientId: client.id,
      name: 'ftp',
      host: 'h',
      username: 'u',
      passwordSecretRef: 'transport:password:secret-ref-1',
    });

    expect(transport.passwordSecretRef).toBe('transport:password:secret-ref-1');
  });

  it('update() can set and clear passwordSecretRef on an ftp transport', () => {
    const ctx = createTestContext();
    const client = seedClient(ctx);
    const transport = ctx.transportsRepo.createFtp({
      clientId: client.id,
      name: 'ftp',
      host: 'h',
      username: 'u',
    });

    const updated = ctx.transportsRepo.update(transport.id, { passwordSecretRef: 'transport:password:secret-ref-2' });
    expect(updated.passwordSecretRef).toBe('transport:password:secret-ref-2');

    const cleared = ctx.transportsRepo.update(transport.id, { passwordSecretRef: null });
    expect(cleared.passwordSecretRef).toBeNull();
  });
});
