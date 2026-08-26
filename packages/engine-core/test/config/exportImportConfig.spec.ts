import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exportConfig, exportTask } from '../../src/config/exportConfig.js';
import { importConfig, importTaskBundle } from '../../src/config/importConfig.js';
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
    passphraseSecretRef: 'transport:passphrase:secret-ref-1',
  });
  const ssh = ctx.transportsRepo.createSsh({
    clientId: client.id,
    name: 'SSH remote dump',
    host: 'h2',
    username: 'u2',
    privateKeyPath: 'k2',
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
    remotePath: '/backups',
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
    remoteCommand: 'pg_dump ...',
    remoteOutputPathTemplate: '/tmp/{date:YYYYMMDD}.dump',
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
          remotePath: '/backups',
          remoteFilePattern: null,
          remoteCommand: null,
          remoteOutputPathTemplate: null,
          remoteCleanup: false,
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
          hasPassword: false,
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

describe('exportTask / importTaskBundle', () => {
  it('exports a fetch_existing task with its transport, not the whole client', () => {
    const ctx = createTestContext();
    const { fetchTask } = seedFullClient(ctx);

    const bundle = exportTask(fetchTask.id, ctx);

    expect(bundle.task.name).toBe('Fetch task');
    expect(bundle.task.strategy).toBe('fetch_existing');
    expect(bundle.task.transportName).toBe('SFTP main');
    expect(bundle.transport).not.toBeNull();
    expect(bundle.transport!.name).toBe('SFTP main');
    expect(bundle.transport!.type).toBe('sftp');
    expect(bundle.databaseConnection).toBeNull();
  });

  it('exports a direct_dump task with its database connection, not a transport', () => {
    const ctx = createTestContext();
    const { directTask } = seedFullClient(ctx);

    const bundle = exportTask(directTask.id, ctx);

    expect(bundle.task.strategy).toBe('direct_dump');
    expect(bundle.transport).toBeNull();
    expect(bundle.databaseConnection).not.toBeNull();
    expect(bundle.databaseConnection!.name).toBe('Postgres direct');
    expect(bundle.databaseConnection!.hasPassword).toBe(true);
  });

  it('throws a clean error exporting a nonexistent task', () => {
    const ctx = createTestContext();
    expect(() => exportTask('nonexistent', ctx)).toThrow(/not found/i);
  });

  it('attaches an exported task+transport to an existing client on a different machine, restoring its schedule and flagging secrets', () => {
    const sourceCtx = createTestContext();
    const { fetchTask } = seedFullClient(sourceCtx);
    const bundle = exportTask(fetchTask.id, sourceCtx);

    const targetCtx = createTestContext();
    const existingClient = targetCtx.clientsRepo.create({ name: 'Already Here', localBasePath: 'D:/x' });

    const result = importTaskBundle(bundle, existingClient.id, targetCtx);

    expect(result.errors).toEqual([]);
    expect(result.transportCreated).toBe(true);
    expect(result.databaseConnectionCreated).toBe(false);
    expect(result.taskId).not.toBeNull();
    // 'k1' isn't a real file in this fixture (manual copy needed) + the passphrase itself.
    expect(result.secretsNeedingReentry).toHaveLength(2);
    expect(result.secretsNeedingReentry.some((s) => s.includes('passphrase'))).toBe(true);

    // No new client was created -- it landed on the one that already existed.
    expect(targetCtx.clientsRepo.listActive().map((c) => c.name)).toEqual(['Already Here']);

    const importedTask = targetCtx.tasksRepo.listByClient(existingClient.id).find((t) => t.name === 'Fetch task')!;
    expect(importedTask.scheduleTime).toBe('03:00');
    expect(importedTask.scheduleFrequency).toBe('weekly');
    expect(importedTask.scheduleDaysOfWeek).toEqual([1, 3, 5]);

    const importedTransport = targetCtx.transportsRepo.listByClient(existingClient.id)[0];
    expect(importedTransport.name).toBe('SFTP main');
    expect(importedTransport.type).toBe('sftp');
  });

  it('attaches an exported direct_dump task+database connection to an existing client', () => {
    const sourceCtx = createTestContext();
    const { directTask } = seedFullClient(sourceCtx);
    const bundle = exportTask(directTask.id, sourceCtx);

    const targetCtx = createTestContext();
    const existingClient = targetCtx.clientsRepo.create({ name: 'Already Here', localBasePath: 'D:/x' });

    const result = importTaskBundle(bundle, existingClient.id, targetCtx);

    expect(result.errors).toEqual([]);
    expect(result.databaseConnectionCreated).toBe(true);
    expect(result.transportCreated).toBe(false);
    expect(result.secretsNeedingReentry).toEqual(['database connection "Postgres direct" needs its password re-entered']);

    const importedConn = targetCtx.databaseConnectionsRepo.listByClient(existingClient.id)[0];
    expect(importedConn.name).toBe('Postgres direct');
  });

  it('fails cleanly, creating nothing, when the target client does not exist', () => {
    const sourceCtx = createTestContext();
    const { fetchTask } = seedFullClient(sourceCtx);
    const bundle = exportTask(fetchTask.id, sourceCtx);

    const targetCtx = createTestContext();
    const result = importTaskBundle(bundle, 'nonexistent-client-id', targetCtx);

    expect(result.taskId).toBeNull();
    expect(result.transportCreated).toBe(false);
    expect(result.errors).toEqual(['Client nonexistent-client-id not found.']);
  });

  it('round-trips an ftp transport, with no private key and a password re-entry flag', () => {
    const sourceCtx = createTestContext();
    const client = sourceCtx.clientsRepo.create({ name: 'FtpSource', localBasePath: 'D:/x' });
    const ftp = sourceCtx.transportsRepo.createFtp({
      clientId: client.id,
      name: 'FTP main',
      host: 'h',
      username: 'u',
      passwordSecretRef: 'transport:password:secret-ref-9',
    });
    const task = sourceCtx.tasksRepo.createFetchExisting({
      clientId: client.id,
      transportId: ftp.id,
      name: 'FTP fetch task',
      dbEngine: 'unknown',
      remotePath: '/backups',
    });

    const bundle = exportTask(task.id, sourceCtx);
    expect(bundle.transport!.type).toBe('ftp');
    expect(bundle.transport!.privateKeyPath).toBeNull();
    expect(bundle.transport!.hasPassword).toBe(true);

    const targetCtx = createTestContext();
    const existingClient = targetCtx.clientsRepo.create({ name: 'FtpTarget', localBasePath: 'D:/y' });
    const result = importTaskBundle(bundle, existingClient.id, targetCtx);

    expect(result.errors).toEqual([]);
    expect(result.secretsNeedingReentry).toEqual(['transport "FTP main" needs its FTP password re-entered']);

    const importedTransport = targetCtx.transportsRepo.listByClient(existingClient.id)[0];
    expect(importedTransport.type).toBe('ftp');
    expect(importedTransport.privateKeyPath).toBeNull();
  });
});
