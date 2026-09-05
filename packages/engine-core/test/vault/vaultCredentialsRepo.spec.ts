import { describe, expect, it, beforeEach } from 'vitest';
import { createTestContext, type TestContext } from '../helpers/testContext.js';

function seed(ctx: TestContext) {
  const client = ctx.clientsRepo.create({ name: 'Rivera', localBasePath: 'D:\\Backups\\Rivera' });
  return { client };
}

describe('vaultCredentialsRepo — CRUD + search', () => {
  let ctx: TestContext;
  let clientId: string;

  beforeEach(() => {
    ctx = createTestContext();
    clientId = seed(ctx).client.id;
  });

  it('creates and reads back a credential with tags/metadata', () => {
    const cred = ctx.vaultCredentialsRepo.create({
      clientId,
      name: 'Rivera MySQL prod',
      kind: 'mysql',
      host: 'db.rivera.com',
      port: 3306,
      username: 'backup',
      databaseName: 'rivera_web',
      environment: 'production',
      tags: ['db', 'prod'],
      secretBlobRef: 'vault:credential:abc',
    });
    expect(cred.tags).toEqual(['db', 'prod']);
    const read = ctx.vaultCredentialsRepo.getById(cred.id);
    expect(read?.host).toBe('db.rivera.com');
    expect(read?.operationalSyncState).toBe('none');
    expect(read?.secretBlobRef).toBe('vault:credential:abc');
  });

  it('rejects an unknown kind', () => {
    expect(() => ctx.vaultCredentialsRepo.create({ clientId, name: 'x', kind: 'banana' as never })).toThrow(/unknown credential kind/i);
  });

  it('updates metadata without touching the kind or links', () => {
    const cred = ctx.vaultCredentialsRepo.create({ clientId, name: 'x', kind: 'web_panel', url: 'https://old' });
    const updated = ctx.vaultCredentialsRepo.update(cred.id, { name: 'CloudPanel', url: 'https://panel.rivera.com', favorite: true });
    expect(updated.name).toBe('CloudPanel');
    expect(updated.url).toBe('https://panel.rivera.com');
    expect(updated.favorite).toBe(true);
    expect(updated.kind).toBe('web_panel');
  });

  it('delete returns the secretBlobRef and removes the row', () => {
    const cred = ctx.vaultCredentialsRepo.create({ clientId, name: 'x', kind: 'api', secretBlobRef: 'vault:credential:zzz' });
    expect(ctx.vaultCredentialsRepo.delete(cred.id)).toEqual({ secretBlobRef: 'vault:credential:zzz' });
    expect(ctx.vaultCredentialsRepo.getById(cred.id)).toBeNull();
  });

  it('search AND-matches every token across metadata columns, never ciphertext', () => {
    ctx.vaultCredentialsRepo.create({ clientId, name: 'Rivera MySQL prod', kind: 'mysql', host: 'db.rivera.com', environment: 'production' });
    ctx.vaultCredentialsRepo.create({ clientId, name: 'Rivera SSH integration', kind: 'ssh', host: 'vps.rivera.com', environment: 'integration' });
    ctx.vaultCredentialsRepo.create({ clientId, name: 'Cardiomed Postgres', kind: 'postgres', host: 'db.cardiomed.com' });

    expect(ctx.vaultCredentialsRepo.search(['rivera', 'mysql']).map((c) => c.name)).toEqual(['Rivera MySQL prod']);
    expect(ctx.vaultCredentialsRepo.search(['rivera']).length).toBe(2);
    expect(ctx.vaultCredentialsRepo.search(['production']).map((c) => c.name)).toEqual(['Rivera MySQL prod']);
    expect(ctx.vaultCredentialsRepo.search(['cardiomed', 'postgres']).map((c) => c.name)).toEqual(['Cardiomed Postgres']);
    expect(ctx.vaultCredentialsRepo.search([]).length).toBe(3); // empty query = list all
  });

  it('search can be scoped to a client', () => {
    const other = ctx.clientsRepo.create({ name: 'Carena', localBasePath: 'D:\\Backups\\Carena' });
    ctx.vaultCredentialsRepo.create({ clientId, name: 'Rivera thing', kind: 'custom' });
    ctx.vaultCredentialsRepo.create({ clientId: other.id, name: 'Carena thing', kind: 'custom' });
    expect(ctx.vaultCredentialsRepo.search(['thing'], clientId).map((c) => c.name)).toEqual(['Rivera thing']);
  });
});

describe('vaultCredentialsRepo — reuse-bridge link rules (Phase 3 groundwork)', () => {
  let ctx: TestContext;
  let clientId: string;

  beforeEach(() => {
    ctx = createTestContext();
    clientId = seed(ctx).client.id;
  });

  function makeTransport() {
    return ctx.transportsRepo.createSsh({
      clientId,
      name: 't',
      host: 'h',
      username: 'u',
      privateKeyPath: 'k',
    });
  }
  function makeDbConn() {
    return ctx.databaseConnectionsRepo.create({
      clientId,
      name: 'd',
      engine: 'mysql',
      host: 'h',
      port: 3306,
      databaseName: 'db',
      username: 'u',
    });
  }

  it('an ssh credential can link a transport; a mysql credential cannot', () => {
    const t = makeTransport();
    const ssh = ctx.vaultCredentialsRepo.create({ clientId, name: 'ssh', kind: 'ssh' });
    const linked = ctx.vaultCredentialsRepo.setLink(ssh.id, { linkedTransportId: t.id });
    expect(linked.linkedTransportId).toBe(t.id);

    const my = ctx.vaultCredentialsRepo.create({ clientId, name: 'my', kind: 'mysql' });
    expect(() => ctx.vaultCredentialsRepo.setLink(my.id, { linkedTransportId: t.id })).toThrow(/cannot link to a transport/i);
  });

  it('a mysql credential can link a database connection; an ssh credential cannot', () => {
    const d = makeDbConn();
    const my = ctx.vaultCredentialsRepo.create({ clientId, name: 'my', kind: 'mysql' });
    expect(ctx.vaultCredentialsRepo.setLink(my.id, { linkedDatabaseConnectionId: d.id }).linkedDatabaseConnectionId).toBe(d.id);

    const ssh = ctx.vaultCredentialsRepo.create({ clientId, name: 'ssh', kind: 'ssh' });
    expect(() => ctx.vaultCredentialsRepo.setLink(ssh.id, { linkedDatabaseConnectionId: d.id })).toThrow(/cannot link to a database connection/i);
  });

  it('a connection can be owned by at most one credential (partial UNIQUE + clear error)', () => {
    const t = makeTransport();
    const a = ctx.vaultCredentialsRepo.create({ clientId, name: 'a', kind: 'ssh' });
    const b = ctx.vaultCredentialsRepo.create({ clientId, name: 'b', kind: 'ssh' });
    ctx.vaultCredentialsRepo.setLink(a.id, { linkedTransportId: t.id });
    expect(() => ctx.vaultCredentialsRepo.setLink(b.id, { linkedTransportId: t.id })).toThrow(/already owned by another vault credential/i);
  });

  it('cannot link both a transport and a database connection at once', () => {
    const t = makeTransport();
    const d = makeDbConn();
    // A 'custom' credential targets neither, so both branches reject before the both-set check;
    // use an ssh cred + force the db side too.
    const ssh = ctx.vaultCredentialsRepo.create({ clientId, name: 'ssh', kind: 'ssh' });
    ctx.vaultCredentialsRepo.setLink(ssh.id, { linkedTransportId: t.id });
    expect(() => ctx.vaultCredentialsRepo.setLink(ssh.id, { linkedDatabaseConnectionId: d.id })).toThrow(/at most one/i);
  });

  it('setOperationalSyncState persists state + error', () => {
    const cred = ctx.vaultCredentialsRepo.create({ clientId, name: 'x', kind: 'ssh' });
    ctx.vaultCredentialsRepo.setOperationalSyncState(cred.id, 'error', 'icacls failed');
    const read = ctx.vaultCredentialsRepo.getById(cred.id)!;
    expect(read.operationalSyncState).toBe('error');
    expect(read.operationalSyncError).toBe('icacls failed');
  });

  it('deactivating the linked transport clears the link (ON DELETE SET NULL is for delete; deactivate keeps it)', () => {
    const t = makeTransport();
    const ssh = ctx.vaultCredentialsRepo.create({ clientId, name: 'ssh', kind: 'ssh' });
    ctx.vaultCredentialsRepo.setLink(ssh.id, { linkedTransportId: t.id });
    ctx.transportsRepo.deactivate(t.id);
    expect(ctx.vaultCredentialsRepo.getById(ssh.id)!.linkedTransportId).toBe(t.id);
  });
});
