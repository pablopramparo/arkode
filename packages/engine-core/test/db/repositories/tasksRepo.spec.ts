import { describe, expect, it } from 'vitest';
import { createTestContext } from '../../helpers/testContext.js';

function seedClient(ctx: ReturnType<typeof createTestContext>) {
  return ctx.clientsRepo.create({ name: 'Winners', localBasePath: 'D:/Backups/Winners' });
}

describe('tasksRepo transport/database-connection invariants', () => {
  it('creates a fetch_existing task against an sftp transport', () => {
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

    const task = ctx.tasksRepo.createFetchExisting({
      clientId: client.id,
      transportId: transport.id,
      name: 'task',
      dbEngine: 'unknown',
    });

    expect(task.strategy).toBe('fetch_existing');
    expect(task.transportId).toBe(transport.id);
    expect(task.databaseConnectionId).toBeNull();
  });

  it('rejects a fetch_existing task against an ssh transport', () => {
    const ctx = createTestContext();
    const client = seedClient(ctx);
    const transport = ctx.transportsRepo.createSsh({
      clientId: client.id,
      name: 'ssh',
      host: 'h',
      username: 'u',
      privateKeyPath: 'k',
      remoteCommand: 'pg_dump ...',
      remoteOutputPathTemplate: '/tmp/x.dump',
    });

    expect(() =>
      ctx.tasksRepo.createFetchExisting({
        clientId: client.id,
        transportId: transport.id,
        name: 'task',
        dbEngine: 'unknown',
      })
    ).toThrow(/require a sftp transport/);
  });

  it('rejects a remote_dump task against an sftp transport', () => {
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

    expect(() =>
      ctx.tasksRepo.createRemoteDump({
        clientId: client.id,
        transportId: transport.id,
        name: 'task',
        dbEngine: 'unknown',
      })
    ).toThrow(/require a ssh transport/);
  });

  it('creates a direct_dump task against a database connection', () => {
    const ctx = createTestContext();
    const client = seedClient(ctx);
    const connection = ctx.databaseConnectionsRepo.create({
      clientId: client.id,
      name: 'pg',
      engine: 'postgres',
      host: 'h',
      port: 5432,
      databaseName: 'db',
      username: 'u',
    });

    const task = ctx.tasksRepo.createDirectDump({
      clientId: client.id,
      databaseConnectionId: connection.id,
      name: 'task',
      dbEngine: 'postgres',
    });

    expect(task.strategy).toBe('direct_dump');
    expect(task.databaseConnectionId).toBe(connection.id);
    expect(task.transportId).toBeNull();
  });

  it('rejects a direct_dump task against a nonexistent database connection', () => {
    const ctx = createTestContext();
    const client = seedClient(ctx);

    expect(() =>
      ctx.tasksRepo.createDirectDump({
        clientId: client.id,
        databaseConnectionId: 'does-not-exist',
        name: 'task',
        dbEngine: 'postgres',
      })
    ).toThrow(/not found/);
  });

  it('applies a task-level retention override independent of the client default', () => {
    const ctx = createTestContext();
    const client = ctx.clientsRepo.create({
      name: 'Winners',
      localBasePath: 'D:/Backups/Winners',
      retentionCount: 30,
    });
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
      retentionCount: 5,
    });

    expect(task.retentionCount).toBe(5);
    expect(client.retentionCount).toBe(30);
  });
});

describe('tasksRepo update/deactivate/reactivate', () => {
  function seedTask(ctx: ReturnType<typeof createTestContext>) {
    const client = seedClient(ctx);
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
      retentionCount: 10,
    });
    return { client, transport, task };
  }

  it('updates only the fields provided, leaving strategy/transport untouched', () => {
    const ctx = createTestContext();
    const { task, transport } = seedTask(ctx);

    const updated = ctx.tasksRepo.update(task.id, { name: 'renamed' });

    expect(updated.name).toBe('renamed');
    expect(updated.retentionCount).toBe(10); // untouched
    expect(updated.transportId).toBe(transport.id); // no way to change this via update()
  });

  it('allows explicitly clearing a nullable retention field by passing null', () => {
    const ctx = createTestContext();
    const { task } = seedTask(ctx);

    const updated = ctx.tasksRepo.update(task.id, { retentionCount: null });

    expect(updated.retentionCount).toBeNull();
  });

  it('throws a clean error when updating a nonexistent task', () => {
    const ctx = createTestContext();
    expect(() => ctx.tasksRepo.update('nonexistent', { name: 'x' })).toThrow(/not found/i);
  });

  it('deactivate() then reactivate() round-trips is_active', () => {
    const ctx = createTestContext();
    const { task } = seedTask(ctx);

    ctx.tasksRepo.deactivate(task.id);
    expect(ctx.tasksRepo.getById(task.id)).toMatchObject({ isActive: false });

    ctx.tasksRepo.reactivate(task.id);
    expect(ctx.tasksRepo.getById(task.id)).toMatchObject({ isActive: true });
  });

  it('throws a clean error when deactivating or reactivating a nonexistent task', () => {
    const ctx = createTestContext();
    expect(() => ctx.tasksRepo.deactivate('nonexistent')).toThrow(/not found/i);
    expect(() => ctx.tasksRepo.reactivate('nonexistent')).toThrow(/not found/i);
  });
});
