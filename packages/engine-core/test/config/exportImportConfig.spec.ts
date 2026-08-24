import { describe, expect, it } from 'vitest';
import { exportConfig } from '../../src/config/exportConfig.js';
import { importConfig } from '../../src/config/importConfig.js';
import { createTestContext, type TestContext } from '../helpers/testContext.js';

function seedFullClient(ctx: TestContext, name = 'Winners') {
  const client = ctx.clientsRepo.create({ name, localBasePath: `D:/Backups/${name}`, retentionCount: 30 });

  const sftp = ctx.transportsRepo.createSftp({
    clientId: client.id,
    name: 'SFTP main',
    host: 'h1',
    username: 'u1',
    privateKeyPath: 'k1',
    remotePath: '/backups',
    passphraseSecretRef: 'transport:passphrase:secret-ref-1',
  });
  const ssh = ctx.transportsRepo.createSsh({
    clientId: client.id,
    name: 'SSH remote dump',
    host: 'h2',
    username: 'u2',
    privateKeyPath: 'k2',
    remoteCommand: 'pg_dump ...',
    remoteOutputPathTemplate: '/tmp/{date:YYYYMMDD}.dump',
  });
  const pgConn = ctx.databaseConnectionsRepo.create({
    clientId: client.id,
    name: 'Postgres direct',
    engine: 'postgres',
    host: 'h3',
    port: 5432,
    databaseName: 'db',
    username: 'u3',
    passwordSecretRef: 'databaseConnection:password:secret-ref-2',
  });

  const fetchTask = ctx.tasksRepo.createFetchExisting({
    clientId: client.id,
    transportId: sftp.id,
    name: 'Fetch task',
    dbEngine: 'unknown',
    retentionCount: 5,
  });
  const remoteTask = ctx.tasksRepo.createRemoteDump({
    clientId: client.id,
    transportId: ssh.id,
    name: 'Remote dump task',
    dbEngine: 'postgres',
  });
  const directTask = ctx.tasksRepo.createDirectDump({
    clientId: client.id,
    databaseConnectionId: pgConn.id,
    name: 'Direct dump task',
    dbEngine: 'postgres',
  });

  return { client, sftp, ssh, pgConn, fetchTask, remoteTask, directTask };
}

describe('exportConfig', () => {
  it('exports a client with its transports, database connections, and tasks — with no secret values', () => {
    const ctx = createTestContext();
    seedFullClient(ctx);

    const exported = exportConfig('all', ctx);
    expect(exported.clients).toHaveLength(1);
    const client = exported.clients[0];

    expect(client.name).toBe('Winners');
    expect(client.retentionCount).toBe(30);

    expect(client.transports).toHaveLength(2);
    const sftpExport = client.transports.find((t) => t.type === 'sftp')!;
    expect(sftpExport.hasPassphrase).toBe(true);
    const sshExport = client.transports.find((t) => t.type === 'ssh')!;
    expect(sshExport.hasPassphrase).toBe(false);

    expect(client.databaseConnections).toHaveLength(1);
    expect(client.databaseConnections[0].hasPassword).toBe(true);

    expect(client.tasks).toHaveLength(3);
    expect(client.tasks.find((t) => t.strategy === 'fetch_existing')?.transportName).toBe('SFTP main');
    expect(client.tasks.find((t) => t.strategy === 'remote_dump')?.transportName).toBe('SSH remote dump');
    expect(client.tasks.find((t) => t.strategy === 'direct_dump')?.databaseConnectionName).toBe('Postgres direct');

    // No secret value or secret_ref ever appears in the export.
    const serialized = JSON.stringify(exported);
    expect(serialized).not.toMatch(/secret-ref/);
  });

  it('exports only the requested client ids, not every client', () => {
    const ctx = createTestContext();
    seedFullClient(ctx, 'Winners');
    seedFullClient(ctx, 'Carena');

    const exported = exportConfig([ctx.clientsRepo.getByName('Carena')!.id], ctx);
    expect(exported.clients.map((c) => c.name)).toEqual(['Carena']);
  });
});

describe('importConfig', () => {
  it('recreates a client from its export, flagging secrets that need re-entry', () => {
    const sourceCtx = createTestContext();
    const { pgConn } = seedFullClient(sourceCtx);
    const exported = exportConfig('all', sourceCtx);

    const targetCtx = createTestContext();
    const result = importConfig(exported, targetCtx);

    expect(result.clients).toHaveLength(1);
    const clientResult = result.clients[0];
    expect(clientResult.errors).toEqual([]);
    expect(clientResult.clientId).not.toBeNull();
    expect(clientResult.transportsCreated).toBe(2);
    expect(clientResult.databaseConnectionsCreated).toBe(1);
    expect(clientResult.tasksCreated).toBe(3);
    expect(clientResult.secretsNeedingReentry).toHaveLength(2);
    expect(clientResult.secretsNeedingReentry.some((s) => s.includes('passphrase'))).toBe(true);
    expect(clientResult.secretsNeedingReentry.some((s) => s.includes('password'))).toBe(true);

    // Tasks in the new DB correctly reference the newly-created (different-id) transports/connections.
    const importedClient = targetCtx.clientsRepo.getByName('Winners')!;
    const importedTasks = targetCtx.tasksRepo.listByClient(importedClient.id);
    const directTask = importedTasks.find((t) => t.strategy === 'direct_dump')!;
    expect(directTask.databaseConnectionId).not.toBeNull();
    expect(directTask.databaseConnectionId).not.toBe(pgConn.id); // a freshly-generated id in the new DB, not the source's
  });

  it('re-exporting an imported client reproduces the same structure, except secrets are correctly gone', () => {
    const sourceCtx = createTestContext();
    seedFullClient(sourceCtx);
    const firstExport = exportConfig('all', sourceCtx);

    const targetCtx = createTestContext();
    importConfig(firstExport, targetCtx);
    const secondExport = exportConfig('all', targetCtx);

    // Secrets are never carried across import — hasPassphrase/hasPassword
    // must flip to false until the user re-enters them. Everything else
    // should round-trip identically.
    const expectedSecondExport = structuredClone(firstExport.clients);
    for (const client of expectedSecondExport) {
      for (const t of client.transports) t.hasPassphrase = false;
      for (const c of client.databaseConnections) c.hasPassword = false;
    }
    expect(secondExport.clients).toEqual(expectedSecondExport);
  });

  it('fails just that client (not the whole batch) when a client name already exists, and does not touch its data', () => {
    const ctx = createTestContext();
    seedFullClient(ctx, 'Winners');
    const exported = exportConfig('all', ctx); // exporting the same DB we're about to import into

    const result = importConfig(exported, ctx);

    expect(result.clients[0].clientId).toBeNull();
    expect(result.clients[0].errors[0]).toMatch(/Winners/);
    // Original client untouched — still exactly one "Winners".
    expect(ctx.clientsRepo.listActive().filter((c) => c.name === 'Winners')).toHaveLength(1);
  });

  it('records a per-task error (without failing the rest of the import) when a task references an unresolvable transport', () => {
    const ctx = createTestContext();
    const exported = exportConfig('all', createTestContext()); // empty source, we'll hand-build a malformed one instead
    exported.clients.push({
      name: 'Broken',
      description: null,
      localBasePath: 'D:/Backups/Broken',
      retentionCount: null,
      retentionDays: null,
      transports: [],
      databaseConnections: [],
      tasks: [
        {
          name: 'Orphan task',
          strategy: 'fetch_existing',
          transportName: 'does-not-exist',
          databaseConnectionName: null,
          dbEngine: 'unknown',
          scheduleTime: null,
          scheduleEnabled: true,
          retentionCount: null,
          retentionDays: null,
        },
      ],
    });

    const result = importConfig(exported, ctx);
    const brokenResult = result.clients.find((c) => c.name === 'Broken')!;
    expect(brokenResult.clientId).not.toBeNull(); // the client itself still gets created
    expect(brokenResult.tasksCreated).toBe(0);
    expect(brokenResult.errors[0]).toMatch(/does-not-exist/);
  });
});
