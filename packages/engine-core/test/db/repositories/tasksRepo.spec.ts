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
    });

    const task = ctx.tasksRepo.createFetchExisting({
      clientId: client.id,
      transportId: transport.id,
      name: 'task',
      dbEngine: 'unknown',
      remotePath: '/backups',
    });

    expect(task.strategy).toBe('fetch_existing');
    expect(task.transportId).toBe(transport.id);
    expect(task.databaseConnectionId).toBeNull();
    expect(task.remotePath).toBe('/backups');
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
    });

    expect(() =>
      ctx.tasksRepo.createFetchExisting({
        clientId: client.id,
        transportId: transport.id,
        name: 'task',
        dbEngine: 'unknown',
      })
    ).toThrow(/require a sftp or ftp transport/);
  });

  it('accepts a fetch_existing task against an ftp transport, like sftp', () => {
    const ctx = createTestContext();
    const client = seedClient(ctx);
    const transport = ctx.transportsRepo.createFtp({
      clientId: client.id,
      name: 'ftp',
      host: 'h',
      username: 'u',
    });

    const task = ctx.tasksRepo.createFetchExisting({
      clientId: client.id,
      transportId: transport.id,
      name: 'task',
      dbEngine: 'unknown',
      remotePath: '/backups',
    });

    expect(task.strategy).toBe('fetch_existing');
    expect(task.transportId).toBe(transport.id);
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

  function seedSshTransport(ctx: ReturnType<typeof createTestContext>, clientId: string) {
    return ctx.transportsRepo.createSsh({ clientId, name: 'ssh', host: 'h', username: 'u', privateKeyPath: 'k' });
  }

  it('creates a host-mode (default) remote_dump task exactly as before docker mode existed', () => {
    const ctx = createTestContext();
    const client = seedClient(ctx);
    const transport = seedSshTransport(ctx, client.id);

    const task = ctx.tasksRepo.createRemoteDump({
      clientId: client.id,
      transportId: transport.id,
      name: 'task',
      dbEngine: 'mysql',
      remoteCommand: 'mysqldump db > /tmp/dump.sql',
      remoteOutputPathTemplate: '/tmp/dump.sql',
    });

    expect(task.remoteDumpExecMode).toBe('host');
    expect(task.dockerContainer).toBeNull();
  });

  it('rejects a host-mode remote_dump task with no remoteCommand', () => {
    const ctx = createTestContext();
    const client = seedClient(ctx);
    const transport = seedSshTransport(ctx, client.id);

    expect(() =>
      ctx.tasksRepo.createRemoteDump({
        clientId: client.id,
        transportId: transport.id,
        name: 'task',
        dbEngine: 'mysql',
        remoteOutputPathTemplate: '/tmp/dump.sql',
      })
    ).toThrow(/execMode "host" require remoteCommand/);
  });

  it('creates a docker-mode remote_dump task with its own structured fields', () => {
    const ctx = createTestContext();
    const client = seedClient(ctx);
    const transport = seedSshTransport(ctx, client.id);

    const task = ctx.tasksRepo.createRemoteDump({
      clientId: client.id,
      transportId: transport.id,
      name: 'task',
      dbEngine: 'postgres',
      remoteDumpExecMode: 'docker',
      dockerContainer: 'u088ggocosggggg4skws8ssc',
      remoteDumpDatabase: 'grupocarena_erp',
      remoteDumpDbUser: 'postgres',
      remoteOutputPathTemplate: '/home/arkode-backup/grupocarena_erp.dump',
    });

    expect(task.remoteDumpExecMode).toBe('docker');
    expect(task.dockerContainer).toBe('u088ggocosggggg4skws8ssc');
    expect(task.remoteDumpDatabase).toBe('grupocarena_erp');
    expect(task.remoteDumpDbUser).toBe('postgres');
    expect(task.remoteDumpDbPasswordSecretRef).toBeNull();
    expect(task.remoteCommand).toBeNull();
  });

  it('rejects a docker-mode remote_dump task missing dockerContainer/remoteDumpDatabase/remoteDumpDbUser', () => {
    const ctx = createTestContext();
    const client = seedClient(ctx);
    const transport = seedSshTransport(ctx, client.id);

    expect(() =>
      ctx.tasksRepo.createRemoteDump({
        clientId: client.id,
        transportId: transport.id,
        name: 'task',
        dbEngine: 'postgres',
        remoteDumpExecMode: 'docker',
        remoteOutputPathTemplate: '/home/arkode-backup/db.dump',
      })
    ).toThrow(/execMode "docker" require dockerContainer/);
  });

  it('rejects a docker-mode remote_dump task with dbEngine "unknown"', () => {
    const ctx = createTestContext();
    const client = seedClient(ctx);
    const transport = seedSshTransport(ctx, client.id);

    expect(() =>
      ctx.tasksRepo.createRemoteDump({
        clientId: client.id,
        transportId: transport.id,
        name: 'task',
        dbEngine: 'unknown',
        remoteDumpExecMode: 'docker',
        dockerContainer: 'c1',
        remoteDumpDatabase: 'db',
        remoteDumpDbUser: 'user',
        remoteOutputPathTemplate: '/home/arkode-backup/db.dump',
      })
    ).toThrow(/require a specific dbEngine/);
  });

  it('creates a docker-mode remote_dump task with an optional password secret ref', () => {
    const ctx = createTestContext();
    const client = seedClient(ctx);
    const transport = seedSshTransport(ctx, client.id);

    const task = ctx.tasksRepo.createRemoteDump({
      clientId: client.id,
      transportId: transport.id,
      name: 'task',
      dbEngine: 'mysql',
      remoteDumpExecMode: 'docker',
      dockerContainer: 'c1',
      remoteDumpDatabase: 'db',
      remoteDumpDbUser: 'root',
      remoteDumpDbPasswordSecretRef: 'secret:ref:1',
      remoteOutputPathTemplate: '/home/arkode-backup/db.sql',
    });

    expect(task.remoteDumpDbPasswordSecretRef).toBe('secret:ref:1');
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
    });

    const task = ctx.tasksRepo.createFetchExisting({
      clientId: client.id,
      transportId: transport.id,
      name: 'task',
      dbEngine: 'unknown',
      remotePath: '/backups',
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
    });
    const task = ctx.tasksRepo.createFetchExisting({
      clientId: client.id,
      transportId: transport.id,
      name: 'task',
      dbEngine: 'unknown',
      remotePath: '/backups',
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

describe('tasksRepo.update remote-* pipeline fields (only while no real backup exists)', () => {
  function seedSshTransport(ctx: ReturnType<typeof createTestContext>, clientId: string) {
    return ctx.transportsRepo.createSsh({ clientId, name: 'ssh', host: 'h', username: 'u', privateKeyPath: 'k' });
  }

  function seedRemoteDumpTask(ctx: ReturnType<typeof createTestContext>) {
    const client = seedClient(ctx);
    const transport = seedSshTransport(ctx, client.id);
    const task = ctx.tasksRepo.createRemoteDump({
      clientId: client.id,
      transportId: transport.id,
      name: 'task',
      dbEngine: 'mysql',
      remoteCommand: 'mysqldump wrong > /tmp/wrong.sql',
      remoteOutputPathTemplate: '/tmp/wrong.sql',
    });
    return { client, transport, task };
  }

  /** Record a Success run with a file on disk — makes hasRealBackup true. */
  function seedRealBackup(ctx: ReturnType<typeof createTestContext>, task: { id: string; clientId: string; strategy: string; transportId: string | null }) {
    const run = ctx.runsRepo.create({
      taskId: task.id,
      clientId: task.clientId,
      strategy: task.strategy as 'remote_dump',
      transportId: task.transportId,
      databaseConnectionId: null,
      pid: 1,
    });
    ctx.runsRepo.markValidating(run.id, {
      fileName: 'dump.sql',
      sizeBytes: 10,
      checksumSha256: 'abc',
      localPath: 'D:/Backups/Winners/dump.sql',
    });
    ctx.runsRepo.markFinished(run.id, 'Success');
  }

  it('edits remoteCommand + remoteOutputPathTemplate on a remote_dump task that has no real backup', () => {
    const ctx = createTestContext();
    const { task } = seedRemoteDumpTask(ctx);

    const updated = ctx.tasksRepo.update(task.id, {
      remoteCommand: 'mysqldump --single-transaction web > /home/arkode-backup/web.sql',
      remoteOutputPathTemplate: '/home/arkode-backup/web.sql',
      remoteCleanup: true,
    });

    expect(updated.remoteCommand).toBe('mysqldump --single-transaction web > /home/arkode-backup/web.sql');
    expect(updated.remoteOutputPathTemplate).toBe('/home/arkode-backup/web.sql');
    expect(updated.remoteCleanup).toBe(true);
  });

  it('a Failed run does NOT lock the pipeline fields — only a real (Success/Warning + file) backup does', () => {
    const ctx = createTestContext();
    const { task } = seedRemoteDumpTask(ctx);
    const run = ctx.runsRepo.create({
      taskId: task.id,
      clientId: task.clientId,
      strategy: 'remote_dump',
      transportId: task.transportId,
      databaseConnectionId: null,
      pid: 1,
    });
    ctx.runsRepo.markFinished(run.id, 'Failed', { errorMessage: 'No such file' });

    const updated = ctx.tasksRepo.update(task.id, { remoteCommand: 'mysqldump web > /home/arkode-backup/web.sql' });
    expect(updated.remoteCommand).toBe('mysqldump web > /home/arkode-backup/web.sql');
  });

  it('refuses to edit the pipeline fields once the task has a real backup', () => {
    const ctx = createTestContext();
    const { task } = seedRemoteDumpTask(ctx);
    seedRealBackup(ctx, task);

    expect(() => ctx.tasksRepo.update(task.id, { remoteCommand: 'anything' })).toThrow(/already has real backups/i);
  });

  it('still allows a name/retention edit after a real backup exists (pipeline fields untouched)', () => {
    const ctx = createTestContext();
    const { task } = seedRemoteDumpTask(ctx);
    seedRealBackup(ctx, task);

    const updated = ctx.tasksRepo.update(task.id, { name: 'renamed', retentionCount: 3 });
    expect(updated.name).toBe('renamed');
    expect(updated.retentionCount).toBe(3);
    expect(updated.remoteCommand).toBe('mysqldump wrong > /tmp/wrong.sql'); // unchanged
  });

  it('rejects clearing a remote_dump task\'s required output path template', () => {
    const ctx = createTestContext();
    const { task } = seedRemoteDumpTask(ctx);

    expect(() => ctx.tasksRepo.update(task.id, { remoteOutputPathTemplate: '   ' })).toThrow(/require a remote output path template/i);
  });

  it('rejects clearing a host-mode remote_dump task\'s required command', () => {
    const ctx = createTestContext();
    const { task } = seedRemoteDumpTask(ctx);

    expect(() => ctx.tasksRepo.update(task.id, { remoteCommand: '' })).toThrow(/execMode "host" require a remote command/i);
  });

  it('rejects fetch_existing-only fields on a remote_dump task', () => {
    const ctx = createTestContext();
    const { task } = seedRemoteDumpTask(ctx);

    expect(() => ctx.tasksRepo.update(task.id, { remotePath: '/x' })).toThrow(/no remote path/i);
  });

  it('edits a fetch_existing task\'s remotePath / remoteFilePattern, and normalises an emptied pattern to null', () => {
    const ctx = createTestContext();
    const client = seedClient(ctx);
    const transport = ctx.transportsRepo.createSftp({ clientId: client.id, name: 'sftp', host: 'h', username: 'u', privateKeyPath: 'k' });
    const task = ctx.tasksRepo.createFetchExisting({
      clientId: client.id,
      transportId: transport.id,
      name: 'task',
      dbEngine: 'unknown',
      remotePath: '/old',
      remoteFilePattern: '*.old',
    });

    const updated = ctx.tasksRepo.update(task.id, { remotePath: '/backups/new', remoteFilePattern: '  ' });
    expect(updated.remotePath).toBe('/backups/new');
    expect(updated.remoteFilePattern).toBeNull();
  });

  it('rejects clearing a fetch_existing task\'s required remote path', () => {
    const ctx = createTestContext();
    const client = seedClient(ctx);
    const transport = ctx.transportsRepo.createSftp({ clientId: client.id, name: 'sftp', host: 'h', username: 'u', privateKeyPath: 'k' });
    const task = ctx.tasksRepo.createFetchExisting({
      clientId: client.id,
      transportId: transport.id,
      name: 'task',
      dbEngine: 'unknown',
      remotePath: '/backups',
    });

    expect(() => ctx.tasksRepo.update(task.id, { remotePath: '' })).toThrow(/require a remote path/i);
  });

  it('rejects any pipeline field on a direct_dump task', () => {
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
    const task = ctx.tasksRepo.createDirectDump({ clientId: client.id, databaseConnectionId: connection.id, name: 'task', dbEngine: 'postgres' });

    expect(() => ctx.tasksRepo.update(task.id, { remoteCommand: 'x' })).toThrow(/no remote command/i);
  });
});

describe('tasksRepo.setSchedule frequency', () => {
  function seedTask(ctx: ReturnType<typeof createTestContext>) {
    const client = seedClient(ctx);
    const transport = ctx.transportsRepo.createSftp({
      clientId: client.id,
      name: 'sftp',
      host: 'h',
      username: 'u',
      privateKeyPath: 'k',
    });
    return ctx.tasksRepo.createFetchExisting({
      clientId: client.id,
      transportId: transport.id,
      name: 'task',
      dbEngine: 'unknown',
      remotePath: '/backups',
    });
  }

  it('defaults a fresh task to daily with no days-of-week/day-of-month', () => {
    const ctx = createTestContext();
    const task = seedTask(ctx);
    expect(task.scheduleFrequency).toBe('daily');
    expect(task.scheduleDaysOfWeek).toBeNull();
    expect(task.scheduleDayOfMonth).toBeNull();
  });

  it('sets a weekly schedule with specific days of the week', () => {
    const ctx = createTestContext();
    const task = seedTask(ctx);

    const updated = ctx.tasksRepo.setSchedule(task.id, {
      scheduleTime: '03:00',
      scheduleEnabled: true,
      scheduleFrequency: 'weekly',
      scheduleDaysOfWeek: [1, 3, 5],
    });

    expect(updated.scheduleFrequency).toBe('weekly');
    expect(updated.scheduleDaysOfWeek).toEqual([1, 3, 5]);
    expect(updated.scheduleDayOfMonth).toBeNull();
  });

  it('sets a monthly schedule with a specific day of the month', () => {
    const ctx = createTestContext();
    const task = seedTask(ctx);

    const updated = ctx.tasksRepo.setSchedule(task.id, {
      scheduleTime: '03:00',
      scheduleEnabled: true,
      scheduleFrequency: 'monthly',
      scheduleDayOfMonth: 15,
    });

    expect(updated.scheduleFrequency).toBe('monthly');
    expect(updated.scheduleDayOfMonth).toBe(15);
    expect(updated.scheduleDaysOfWeek).toBeNull();
  });

  it('rejects a weekly schedule with no days of the week', () => {
    const ctx = createTestContext();
    const task = seedTask(ctx);
    expect(() =>
      ctx.tasksRepo.setSchedule(task.id, { scheduleTime: '03:00', scheduleEnabled: true, scheduleFrequency: 'weekly', scheduleDaysOfWeek: [] })
    ).toThrow(/at least one day of the week/i);
  });

  it('rejects an out-of-range day of the week', () => {
    const ctx = createTestContext();
    const task = seedTask(ctx);
    expect(() =>
      ctx.tasksRepo.setSchedule(task.id, { scheduleTime: '03:00', scheduleEnabled: true, scheduleFrequency: 'weekly', scheduleDaysOfWeek: [7] })
    ).toThrow(/0 \(Sunday\) through 6 \(Saturday\)/);
  });

  it('rejects a monthly schedule with no day of the month', () => {
    const ctx = createTestContext();
    const task = seedTask(ctx);
    expect(() =>
      ctx.tasksRepo.setSchedule(task.id, { scheduleTime: '03:00', scheduleEnabled: true, scheduleFrequency: 'monthly', scheduleDayOfMonth: null })
    ).toThrow(/between 1 and 31/);
  });

  it('rejects an out-of-range day of the month', () => {
    const ctx = createTestContext();
    const task = seedTask(ctx);
    expect(() =>
      ctx.tasksRepo.setSchedule(task.id, { scheduleTime: '03:00', scheduleEnabled: true, scheduleFrequency: 'monthly', scheduleDayOfMonth: 32 })
    ).toThrow(/between 1 and 31/);
  });

  it('preserves the configured frequency/days across an update that omits them (e.g. just toggling scheduleEnabled)', () => {
    const ctx = createTestContext();
    const task = seedTask(ctx);
    ctx.tasksRepo.setSchedule(task.id, {
      scheduleTime: '03:00',
      scheduleEnabled: true,
      scheduleFrequency: 'weekly',
      scheduleDaysOfWeek: [2, 4],
    });

    const updated = ctx.tasksRepo.setSchedule(task.id, { scheduleTime: '03:00', scheduleEnabled: false });

    expect(updated.scheduleEnabled).toBe(false);
    expect(updated.scheduleFrequency).toBe('weekly');
    expect(updated.scheduleDaysOfWeek).toEqual([2, 4]);
  });

  it('switching back to daily drops any previously configured days of the week', () => {
    const ctx = createTestContext();
    const task = seedTask(ctx);
    ctx.tasksRepo.setSchedule(task.id, {
      scheduleTime: '03:00',
      scheduleEnabled: true,
      scheduleFrequency: 'weekly',
      scheduleDaysOfWeek: [2, 4],
    });

    const updated = ctx.tasksRepo.setSchedule(task.id, {
      scheduleTime: '03:00',
      scheduleEnabled: true,
      scheduleFrequency: 'daily',
    });

    expect(updated.scheduleFrequency).toBe('daily');
    expect(updated.scheduleDaysOfWeek).toBeNull();
  });
});
