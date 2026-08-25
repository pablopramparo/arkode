import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exportConfig } from '../../src/config/exportConfig.js';
import { importConfig } from '../../src/config/importConfig.js';
import { createTestContext, type TestContext } from '../helpers/testContext.js';
import { withTempDir } from '../helpers/tempDir.js';

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

  const fetchTaskUnscheduled = ctx.tasksRepo.createFetchExisting({
    clientId: client.id,
    transportId: sftp.id,
    name: 'Fetch task',
    dbEngine: 'unknown',
    retentionCount: 5,
  });
  const fetchTask = ctx.tasksRepo.setSchedule(fetchTaskUnscheduled.id, {
    scheduleTime: '03:00',
    scheduleEnabled: true,
    scheduleFrequency: 'weekly',
    scheduleDaysOfWeek: [1, 3, 5],
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
    // 2 credential-manager secrets (passphrase/password) + 2 private keys that couldn't be
    // read at export time ('k1'/'k2' aren't real files in this fixture) needing a manual copy.
    expect(clientResult.secretsNeedingReentry).toHaveLength(4);
    expect(clientResult.secretsNeedingReentry.some((s) => s.includes('passphrase'))).toBe(true);
    expect(clientResult.secretsNeedingReentry.some((s) => s.includes('password'))).toBe(true);
    expect(clientResult.secretsNeedingReentry.filter((s) => s.includes('private key file')).length).toBe(2);

    // Tasks in the new DB correctly reference the newly-created (different-id) transports/connections.
    const importedClient = targetCtx.clientsRepo.getByName('Winners')!;
    const importedTasks = targetCtx.tasksRepo.listByClient(importedClient.id);
    const directTask = importedTasks.find((t) => t.strategy === 'direct_dump')!;
    expect(directTask.databaseConnectionId).not.toBeNull();
    expect(directTask.databaseConnectionId).not.toBe(pgConn.id); // a freshly-generated id in the new DB, not the source's
  });

  it('restores a task\'s schedule (including weekly/monthly frequency), not just its transport/connection', () => {
    const sourceCtx = createTestContext();
    const { fetchTask } = seedFullClient(sourceCtx); // fetchTask has a weekly schedule, Mon/Wed/Fri at 03:00
    const exported = exportConfig('all', sourceCtx);

    const targetCtx = createTestContext();
    importConfig(exported, targetCtx);

    const importedClient = targetCtx.clientsRepo.getByName('Winners')!;
    const importedTask = targetCtx.tasksRepo.listByClient(importedClient.id).find((t) => t.name === fetchTask.name)!;
    expect(importedTask.scheduleTime).toBe('03:00');
    expect(importedTask.scheduleEnabled).toBe(true);
    expect(importedTask.scheduleFrequency).toBe('weekly');
    expect(importedTask.scheduleDaysOfWeek).toEqual([1, 3, 5]);
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
          scheduleFrequency: 'daily',
          scheduleDaysOfWeek: null,
          scheduleDayOfMonth: null,
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

describe('exportConfig private key content', () => {
  it('includes the private key file\'s content (base64) when the file can be read', async () => {
    await withTempDir(async (dir) => {
      const keyPath = join(dir, 'id_rsa');
      writeFileSync(keyPath, 'fake-private-key-bytes');

      const ctx = createTestContext();
      const client = ctx.clientsRepo.create({ name: 'KeyTest', localBasePath: 'D:/x' });
      ctx.transportsRepo.createSftp({
        clientId: client.id,
        name: 'sftp',
        host: 'h',
        username: 'u',
        privateKeyPath: keyPath,
        remotePath: '/backups',
      });

      const exported = exportConfig('all', ctx);
      expect(exported.clients[0].transports[0].privateKeyContentBase64).toBe(
        Buffer.from('fake-private-key-bytes').toString('base64')
      );
    });
  });

  it('leaves privateKeyContentBase64 null when the file cannot be read', () => {
    const ctx = createTestContext();
    const client = ctx.clientsRepo.create({ name: 'KeyTestMissing', localBasePath: 'D:/x' });
    ctx.transportsRepo.createSftp({
      clientId: client.id,
      name: 'sftp',
      host: 'h',
      username: 'u',
      privateKeyPath: 'this/path/does/not/exist',
      remotePath: '/backups',
    });

    const exported = exportConfig('all', ctx);
    expect(exported.clients[0].transports[0].privateKeyContentBase64).toBeNull();
  });
});

describe('importConfig private key restoration', () => {
  it('writes the imported private key to a new file under importedKeysDir, with matching content, and needs no manual re-copy', async () => {
    await withTempDir(async (sourceDir) => {
      await withTempDir(async (keysDir) => {
        const keyPath = join(sourceDir, 'id_rsa');
        writeFileSync(keyPath, 'real-key-bytes');

        const sourceCtx = createTestContext();
        const client = sourceCtx.clientsRepo.create({ name: 'KeyImportTest', localBasePath: 'D:/x' });
        sourceCtx.transportsRepo.createSftp({
          clientId: client.id,
          name: 'sftp',
          host: 'h',
          username: 'u',
          privateKeyPath: keyPath,
          remotePath: '/backups',
        });
        const exported = exportConfig('all', sourceCtx);

        const targetCtx = createTestContext();
        const result = importConfig(exported, { ...targetCtx, importedKeysDir: keysDir });

        const clientResult = result.clients[0];
        expect(clientResult.errors).toEqual([]);
        expect(clientResult.secretsNeedingReentry).toEqual([]);

        const importedClient = targetCtx.clientsRepo.getByName('KeyImportTest')!;
        const importedTransport = targetCtx.transportsRepo.listByClient(importedClient.id)[0];
        expect(importedTransport.privateKeyPath).not.toBe(keyPath);
        expect(importedTransport.privateKeyPath.startsWith(keysDir)).toBe(true);
        expect(readFileSync(importedTransport.privateKeyPath, 'utf8')).toBe('real-key-bytes');
      });
    });
  });

  it('falls back to the original path and flags a manual copy when the key content is missing from the export', () => {
    const ctx = createTestContext();
    const exported = exportConfig('all', createTestContext());
    exported.clients.push({
      name: 'NoKeyContent',
      description: null,
      localBasePath: 'D:/x',
      retentionCount: null,
      retentionDays: null,
      transports: [
        {
          name: 't1',
          type: 'sftp',
          host: 'h',
          port: 22,
          username: 'u',
          privateKeyPath: '/original/machine/path/id_rsa',
          privateKeyContentBase64: null,
          hasPassphrase: false,
          remotePath: '/backups',
          remoteFilePattern: null,
          remoteCommand: null,
          remoteOutputPathTemplate: null,
          remoteCleanup: false,
          knownHostFingerprint: null,
        },
      ],
      databaseConnections: [],
      tasks: [],
    });

    const result = importConfig(exported, ctx);
    const clientResult = result.clients.find((c) => c.name === 'NoKeyContent')!;
    expect(clientResult.transportsCreated).toBe(1);
    expect(clientResult.secretsNeedingReentry).toHaveLength(1);
    expect(clientResult.secretsNeedingReentry[0]).toContain('/original/machine/path/id_rsa');

    const importedClient = ctx.clientsRepo.getByName('NoKeyContent')!;
    const importedTransport = ctx.transportsRepo.listByClient(importedClient.id)[0];
    expect(importedTransport.privateKeyPath).toBe('/original/machine/path/id_rsa');
  });
});
