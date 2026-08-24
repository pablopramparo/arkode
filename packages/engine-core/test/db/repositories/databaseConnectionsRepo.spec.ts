import { describe, expect, it } from 'vitest';
import { createTestContext } from '../../helpers/testContext.js';

function seedClient(ctx: ReturnType<typeof createTestContext>) {
  return ctx.clientsRepo.create({ name: 'Winners', localBasePath: 'D:/Backups/Winners' });
}

describe('databaseConnectionsRepo', () => {
  it('updates only the fields provided, leaving the rest untouched', () => {
    const ctx = createTestContext();
    const client = seedClient(ctx);
    const connection = ctx.databaseConnectionsRepo.create({
      clientId: client.id,
      name: 'pg',
      engine: 'postgres',
      host: 'h1',
      port: 5432,
      databaseName: 'winners',
      username: 'u1',
    });

    const updated = ctx.databaseConnectionsRepo.update(connection.id, { host: 'h2' });

    expect(updated.host).toBe('h2');
    expect(updated.username).toBe('u1'); // untouched
    expect(updated.engine).toBe('postgres'); // update() has no way to change this
  });

  it('allows explicitly clearing a nullable field by passing null', () => {
    const ctx = createTestContext();
    const client = seedClient(ctx);
    const connection = ctx.databaseConnectionsRepo.create({
      clientId: client.id,
      name: 'pg',
      engine: 'postgres',
      host: 'h',
      port: 5432,
      databaseName: 'winners',
      username: 'u',
      sslMode: 'require',
    });

    const updated = ctx.databaseConnectionsRepo.update(connection.id, { sslMode: null });

    expect(updated.sslMode).toBeNull();
  });

  it('throws a clean error when updating a nonexistent database connection', () => {
    const ctx = createTestContext();
    expect(() => ctx.databaseConnectionsRepo.update('nonexistent', { host: 'x' })).toThrow(/not found/i);
  });

  it('deactivate() flips is_active without deleting the row', () => {
    const ctx = createTestContext();
    const client = seedClient(ctx);
    const connection = ctx.databaseConnectionsRepo.create({
      clientId: client.id,
      name: 'pg',
      engine: 'postgres',
      host: 'h',
      port: 5432,
      databaseName: 'winners',
      username: 'u',
    });

    ctx.databaseConnectionsRepo.deactivate(connection.id);

    expect(ctx.databaseConnectionsRepo.getById(connection.id)).toMatchObject({ isActive: false });
  });

  it('throws a clean error when deactivating a nonexistent database connection', () => {
    const ctx = createTestContext();
    expect(() => ctx.databaseConnectionsRepo.deactivate('nonexistent')).toThrow(/not found/i);
  });

  it('reactivate() restores is_active after deactivate()', () => {
    const ctx = createTestContext();
    const client = seedClient(ctx);
    const connection = ctx.databaseConnectionsRepo.create({
      clientId: client.id,
      name: 'pg',
      engine: 'postgres',
      host: 'h',
      port: 5432,
      databaseName: 'winners',
      username: 'u',
    });
    ctx.databaseConnectionsRepo.deactivate(connection.id);

    ctx.databaseConnectionsRepo.reactivate(connection.id);

    expect(ctx.databaseConnectionsRepo.getById(connection.id)).toMatchObject({ isActive: true });
  });

  it('throws a clean error when reactivating a nonexistent database connection', () => {
    const ctx = createTestContext();
    expect(() => ctx.databaseConnectionsRepo.reactivate('nonexistent')).toThrow(/not found/i);
  });
});
