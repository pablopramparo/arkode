import { describe, expect, it } from 'vitest';
import { createTestContext } from '../../helpers/testContext.js';
import { createBackupSetsRepo } from '../../../src/db/repositories/backupSetsRepo.js';

describe('backupSetsRepo', () => {
  it('creates a set scoped to a client and reads it back', () => {
    const ctx = createTestContext();
    const backupSetsRepo = createBackupSetsRepo(ctx.db);
    const client = ctx.clientsRepo.create({ name: 'Winners', localBasePath: 'D:/Backups/Winners' });

    const set = backupSetsRepo.create({ clientId: client.id, name: 'Sitio principal' });

    expect(set.clientId).toBe(client.id);
    expect(set.name).toBe('Sitio principal');
    expect(set.isActive).toBe(true);
    expect(backupSetsRepo.getById(set.id)).toEqual(set);
  });

  it('allows the same name for different clients, but rejects a duplicate within the same client', () => {
    const ctx = createTestContext();
    const backupSetsRepo = createBackupSetsRepo(ctx.db);
    const clientA = ctx.clientsRepo.create({ name: 'A', localBasePath: 'D:/A' });
    const clientB = ctx.clientsRepo.create({ name: 'B', localBasePath: 'D:/B' });

    backupSetsRepo.create({ clientId: clientA.id, name: 'Sitio' });
    expect(() => backupSetsRepo.create({ clientId: clientB.id, name: 'Sitio' })).not.toThrow();
    expect(() => backupSetsRepo.create({ clientId: clientA.id, name: 'Sitio' })).toThrow(/already exists/);
  });

  it('update() renames, leaving other fields untouched', () => {
    const ctx = createTestContext();
    const backupSetsRepo = createBackupSetsRepo(ctx.db);
    const client = ctx.clientsRepo.create({ name: 'Winners', localBasePath: 'D:/Backups/Winners' });
    const set = backupSetsRepo.create({ clientId: client.id, name: 'Old name' });

    const updated = backupSetsRepo.update(set.id, { name: 'New name' });

    expect(updated.name).toBe('New name');
    expect(updated.clientId).toBe(client.id);
  });

  it('throws a clean error updating a nonexistent set', () => {
    const ctx = createTestContext();
    const backupSetsRepo = createBackupSetsRepo(ctx.db);
    expect(() => backupSetsRepo.update('nonexistent', { name: 'x' })).toThrow(/not found/i);
  });

  it('deactivate()/reactivate() round-trip is_active', () => {
    const ctx = createTestContext();
    const backupSetsRepo = createBackupSetsRepo(ctx.db);
    const client = ctx.clientsRepo.create({ name: 'Winners', localBasePath: 'D:/Backups/Winners' });
    const set = backupSetsRepo.create({ clientId: client.id, name: 'Sitio' });

    backupSetsRepo.deactivate(set.id);
    expect(backupSetsRepo.getById(set.id)?.isActive).toBe(false);

    backupSetsRepo.reactivate(set.id);
    expect(backupSetsRepo.getById(set.id)?.isActive).toBe(true);
  });

  it('listByClient defaults to active-only, includeInactive shows both', () => {
    const ctx = createTestContext();
    const backupSetsRepo = createBackupSetsRepo(ctx.db);
    const client = ctx.clientsRepo.create({ name: 'Winners', localBasePath: 'D:/Backups/Winners' });
    const active = backupSetsRepo.create({ clientId: client.id, name: 'Active' });
    const inactive = backupSetsRepo.create({ clientId: client.id, name: 'Inactive' });
    backupSetsRepo.deactivate(inactive.id);

    expect(backupSetsRepo.listByClient(client.id).map((s) => s.id)).toEqual([active.id]);
    expect(backupSetsRepo.listByClient(client.id, { includeInactive: true }).map((s) => s.id).sort()).toEqual(
      [active.id, inactive.id].sort()
    );
  });

  it('assigning a task to a set, then unassigning with null, round-trips through tasksRepo.update', () => {
    const ctx = createTestContext();
    const backupSetsRepo = createBackupSetsRepo(ctx.db);
    const client = ctx.clientsRepo.create({ name: 'Winners', localBasePath: 'D:/Backups/Winners' });
    const set = backupSetsRepo.create({ clientId: client.id, name: 'Sitio' });
    const transport = ctx.transportsRepo.createSftp({ clientId: client.id, name: 'sftp', host: 'h', username: 'u', privateKeyPath: 'k' });
    const task = ctx.tasksRepo.createFetchExisting({
      clientId: client.id,
      transportId: transport.id,
      name: 'task',
      dbEngine: 'unknown',
      remotePath: '/backups',
      backupSetId: set.id,
    });
    expect(task.backupSetId).toBe(set.id);

    const unassigned = ctx.tasksRepo.update(task.id, { backupSetId: null });
    expect(unassigned.backupSetId).toBeNull();
  });
});
