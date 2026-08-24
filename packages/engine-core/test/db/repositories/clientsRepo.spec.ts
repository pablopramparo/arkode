import { describe, expect, it } from 'vitest';
import { createTestContext } from '../../helpers/testContext.js';

describe('clientsRepo', () => {
  it('updates only the fields provided, leaving the rest untouched', () => {
    const ctx = createTestContext();
    const client = ctx.clientsRepo.create({
      name: 'Winners',
      description: 'Original description',
      localBasePath: 'D:/Backups/Winners',
      retentionCount: 5,
    });

    const updated = ctx.clientsRepo.update(client.id, { description: 'Updated description' });

    expect(updated.description).toBe('Updated description');
    expect(updated.name).toBe('Winners'); // untouched
    expect(updated.retentionCount).toBe(5); // untouched
  });

  it('allows explicitly clearing a nullable field by passing null', () => {
    const ctx = createTestContext();
    const client = ctx.clientsRepo.create({
      name: 'Winners',
      description: 'Has a description',
      localBasePath: 'D:/Backups/Winners',
    });

    const updated = ctx.clientsRepo.update(client.id, { description: null });

    expect(updated.description).toBeNull();
  });

  it('throws a clean error when updating a nonexistent client', () => {
    const ctx = createTestContext();
    expect(() => ctx.clientsRepo.update('nonexistent', { name: 'X' })).toThrow(/not found/i);
  });

  it('rejects a duplicate name on create with a friendly error, not a raw SQLite constraint message', () => {
    const ctx = createTestContext();
    ctx.clientsRepo.create({ name: 'Winners', localBasePath: 'D:/Backups/Winners' });

    expect(() => ctx.clientsRepo.create({ name: 'Winners', localBasePath: 'D:/Backups/Other' })).toThrow(
      'A client named "Winners" already exists.'
    );
  });

  it('rejects a duplicate name on update with the same friendly error', () => {
    const ctx = createTestContext();
    ctx.clientsRepo.create({ name: 'Winners', localBasePath: 'D:/Backups/Winners' });
    const other = ctx.clientsRepo.create({ name: 'Compagnucci', localBasePath: 'D:/Backups/Compagnucci' });

    expect(() => ctx.clientsRepo.update(other.id, { name: 'Winners' })).toThrow(
      'A client named "Winners" already exists.'
    );
  });

  it('deactivate() removes the client from listActive() without deleting its row', () => {
    const ctx = createTestContext();
    const client = ctx.clientsRepo.create({ name: 'Winners', localBasePath: 'D:/Backups/Winners' });

    ctx.clientsRepo.deactivate(client.id);

    expect(ctx.clientsRepo.listActive()).toHaveLength(0);
    expect(ctx.clientsRepo.getById(client.id)).toMatchObject({ isActive: false });
  });

  it('throws a clean error when deactivating a nonexistent client', () => {
    const ctx = createTestContext();
    expect(() => ctx.clientsRepo.deactivate('nonexistent')).toThrow(/not found/i);
  });

  it('reactivate() restores a deactivated client to listActive()', () => {
    const ctx = createTestContext();
    const client = ctx.clientsRepo.create({ name: 'Winners', localBasePath: 'D:/Backups/Winners' });
    ctx.clientsRepo.deactivate(client.id);

    ctx.clientsRepo.reactivate(client.id);

    expect(ctx.clientsRepo.listActive().map((c) => c.id)).toContain(client.id);
    expect(ctx.clientsRepo.getById(client.id)).toMatchObject({ isActive: true });
  });

  it('throws a clean error when reactivating a nonexistent client', () => {
    const ctx = createTestContext();
    expect(() => ctx.clientsRepo.reactivate('nonexistent')).toThrow(/not found/i);
  });

  it('listAll() includes both active and inactive clients; listActive() only active', () => {
    const ctx = createTestContext();
    const active = ctx.clientsRepo.create({ name: 'Winners', localBasePath: 'D:/Backups/Winners' });
    const inactive = ctx.clientsRepo.create({ name: 'Compagnucci', localBasePath: 'D:/Backups/Compagnucci' });
    ctx.clientsRepo.deactivate(inactive.id);

    expect(ctx.clientsRepo.listAll().map((c) => c.id).sort()).toEqual([active.id, inactive.id].sort());
    expect(ctx.clientsRepo.listActive().map((c) => c.id)).toEqual([active.id]);
  });
});
