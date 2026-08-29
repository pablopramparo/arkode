import Database from 'better-sqlite3';
import { describe, expect, it, beforeEach } from 'vitest';
import { runMigrations } from '../../../../src/db/migrate.js';
import { migrationsSourceDir } from '../../../../src/paths.js';
import { createClientsRepo, type ClientsRepo } from '../../../../src/db/repositories/clientsRepo.js';
import { createTransportsRepo, type TransportsRepo } from '../../../../src/db/repositories/transportsRepo.js';
import { createFileBackupRepositoriesRepo, type FileBackupRepositoriesRepo } from '../../../../src/fileBackup/db/repositories/fileBackupRepositoriesRepo.js';
import { createFileBackupTasksRepo, type FileBackupTasksRepo } from '../../../../src/fileBackup/db/repositories/fileBackupTasksRepo.js';

function freshDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrationsSourceDir());
  return db;
}

describe('fileBackupTasksRepo', () => {
  let clientsRepo: ClientsRepo;
  let transportsRepo: TransportsRepo;
  let reposRepo: FileBackupRepositoriesRepo;
  let tasksRepo: FileBackupTasksRepo;
  let clientId: string;
  let repositoryId: string;
  let sftpTransportId: string;
  let sshTransportId: string;

  beforeEach(() => {
    const db = freshDb();
    clientsRepo = createClientsRepo(db);
    transportsRepo = createTransportsRepo(db);
    reposRepo = createFileBackupRepositoriesRepo(db);
    tasksRepo = createFileBackupTasksRepo(db, transportsRepo);
    clientId = clientsRepo.create({ name: 'Acme', localBasePath: 'D:\\Backups\\Acme' }).id;
    repositoryId = reposRepo.create({ clientId, repoPath: 'D:\\Backups\\Acme\\_restic-repo', passwordSecretRef: 'ref-1' }).id;
    sftpTransportId = transportsRepo.createSftp({
      clientId,
      name: 'sftp',
      host: 'h',
      username: 'u',
      privateKeyPath: 'k',
    }).id;
    sshTransportId = transportsRepo.createSsh({
      clientId,
      name: 'ssh',
      host: 'h',
      username: 'u',
      privateKeyPath: 'k',
    }).id;
  });

  it('creates a local_folder task and reads it back', () => {
    const task = tasksRepo.createLocalFolder({
      clientId,
      repositoryId,
      name: 'Uploads',
      sourcePath: 'D:\\Sites\\acme\\uploads',
    });
    expect(task.sourceKind).toBe('local_folder');
    expect(task.sourcePath).toBe('D:\\Sites\\acme\\uploads');
    expect(task.transportId).toBeNull();
    expect(task.remoteSourcePath).toBeNull();
    expect(task.isActive).toBe(true);
    expect(task.scheduleFrequency).toBe('daily');
    expect(tasksRepo.getById(task.id)).toEqual(task);
  });

  it('rejects a non-absolute or non-Windows-shaped sourcePath', () => {
    expect(() => tasksRepo.createLocalFolder({ clientId, repositoryId, name: 'Bad', sourcePath: 'relative\\path' })).toThrow(
      /absolute Windows path/
    );
    expect(() => tasksRepo.createLocalFolder({ clientId, repositoryId, name: 'Bad', sourcePath: '/C/Users/x' })).toThrow(
      /absolute Windows path/
    );
  });

  it('creates a remote_folder task and reads it back', () => {
    const task = tasksRepo.createRemoteFolder({
      clientId,
      repositoryId,
      name: 'Remote uploads',
      transportId: sftpTransportId,
      remoteSourcePath: '/srv/www/uploads',
    });
    expect(task.sourceKind).toBe('remote_folder');
    expect(task.sourcePath).toBeNull();
    expect(task.transportId).toBe(sftpTransportId);
    expect(task.remoteSourcePath).toBe('/srv/www/uploads');
    expect(tasksRepo.getById(task.id)).toEqual(task);
  });

  it('creates a remote_folder task against an ftp transport too', () => {
    const ftpTransportId = transportsRepo.createFtp({
      clientId,
      name: 'ftp',
      host: 'h',
      username: 'u',
      passwordSecretRef: 'pw-ref',
    }).id;
    const task = tasksRepo.createRemoteFolder({ clientId, repositoryId, name: 'Remote', transportId: ftpTransportId, remoteSourcePath: '/uploads' });
    expect(task.transportId).toBe(ftpTransportId);
  });

  it('rejects a remote_folder task pointed at a non-sftp/ftp transport (e.g. ssh)', () => {
    expect(() =>
      tasksRepo.createRemoteFolder({ clientId, repositoryId, name: 'Bad', transportId: sshTransportId, remoteSourcePath: '/uploads' })
    ).toThrow(/sftp or ftp transport/);
  });

  it('rejects a remote_folder task with a nonexistent transport', () => {
    expect(() =>
      tasksRepo.createRemoteFolder({ clientId, repositoryId, name: 'Bad', transportId: 'nonexistent', remoteSourcePath: '/uploads' })
    ).toThrow(/not found/);
  });

  it('rejects a remote_folder task with an empty remoteSourcePath', () => {
    expect(() =>
      tasksRepo.createRemoteFolder({ clientId, repositoryId, name: 'Bad', transportId: sftpTransportId, remoteSourcePath: '  ' })
    ).toThrow(/remoteSourcePath is required/);
  });

  it('update() changes name/retention but never sourceKind/repositoryId', () => {
    const task = tasksRepo.createLocalFolder({ clientId, repositoryId, name: 'Uploads', sourcePath: 'D:\\Sites\\acme\\uploads' });
    const updated = tasksRepo.update(task.id, { name: 'Uploads renamed', retentionCount: 5 });
    expect(updated.name).toBe('Uploads renamed');
    expect(updated.retentionCount).toBe(5);
    expect(updated.sourcePath).toBe(task.sourcePath); // unchanged when not passed
    expect(updated.repositoryId).toBe(task.repositoryId);
  });

  it('update() can change sourcePath (local) / remoteSourcePath (remote), with validation', () => {
    const local = tasksRepo.createLocalFolder({ clientId, repositoryId, name: 'L', sourcePath: 'D:\\a' });
    expect(tasksRepo.update(local.id, { sourcePath: 'E:\\b\\c' }).sourcePath).toBe('E:\\b\\c');
    expect(() => tasksRepo.update(local.id, { sourcePath: 'relative\\path' })).toThrow(/absolute Windows path/);
    expect(() => tasksRepo.update(local.id, { remoteSourcePath: '/x' })).toThrow(/only applies to a remote_folder/);

    const remote = tasksRepo.createRemoteFolder({ clientId, repositoryId, name: 'R', transportId: sftpTransportId, remoteSourcePath: '/old' });
    expect(tasksRepo.update(remote.id, { remoteSourcePath: '/public_html/public/uploads' }).remoteSourcePath).toBe('/public_html/public/uploads');
    expect(() => tasksRepo.update(remote.id, { remoteSourcePath: '  ' })).toThrow(/cannot be empty/);
    expect(() => tasksRepo.update(remote.id, { sourcePath: 'D:\\x' })).toThrow(/only applies to a local_folder/);
  });

  it('deactivate/reactivate round-trip', () => {
    const task = tasksRepo.createLocalFolder({ clientId, repositoryId, name: 'Uploads', sourcePath: 'D:\\Sites\\acme\\uploads' });
    tasksRepo.deactivate(task.id);
    expect(tasksRepo.getById(task.id)?.isActive).toBe(false);
    tasksRepo.reactivate(task.id);
    expect(tasksRepo.getById(task.id)?.isActive).toBe(true);
  });

  it('listByClient and listByRepository scope correctly across both source kinds', () => {
    const t1 = tasksRepo.createLocalFolder({ clientId, repositoryId, name: 'Uploads', sourcePath: 'D:\\Sites\\acme\\uploads' });
    const t2 = tasksRepo.createRemoteFolder({ clientId, repositoryId, name: 'Remote', transportId: sftpTransportId, remoteSourcePath: '/x' });
    expect(tasksRepo.listByClient(clientId).map((t) => t.id).sort()).toEqual([t1.id, t2.id].sort());
    expect(tasksRepo.listByRepository(repositoryId).map((t) => t.id).sort()).toEqual([t1.id, t2.id].sort());
  });

  it('setSchedule validates weekly/monthly requirements, same as the DB-backup domain', () => {
    const task = tasksRepo.createLocalFolder({ clientId, repositoryId, name: 'Uploads', sourcePath: 'D:\\Sites\\acme\\uploads' });

    expect(() =>
      tasksRepo.setSchedule(task.id, { scheduleTime: '03:00', scheduleEnabled: true, scheduleFrequency: 'weekly', scheduleDaysOfWeek: [] })
    ).toThrow(/at least one day/);

    expect(() =>
      tasksRepo.setSchedule(task.id, { scheduleTime: '03:00', scheduleEnabled: true, scheduleFrequency: 'monthly', scheduleDayOfMonth: 40 })
    ).toThrow(/between 1 and 31/);

    const scheduled = tasksRepo.setSchedule(task.id, {
      scheduleTime: '03:00',
      scheduleEnabled: true,
      scheduleFrequency: 'weekly',
      scheduleDaysOfWeek: [1, 3],
    });
    expect(scheduled.scheduleTime).toBe('03:00');
    expect(scheduled.scheduleDaysOfWeek).toEqual([1, 3]);
  });

  it('setWindowsTaskName records and clears the registered Scheduled Task name', () => {
    const task = tasksRepo.createLocalFolder({ clientId, repositoryId, name: 'Uploads', sourcePath: 'D:\\Sites\\acme\\uploads' });
    expect(task.windowsTaskName).toBeNull();

    const registered = tasksRepo.setWindowsTaskName(task.id, '\\arkode\\' + task.id);
    expect(registered.windowsTaskName).toBe('\\arkode\\' + task.id);
    expect(tasksRepo.getById(task.id)?.windowsTaskName).toBe('\\arkode\\' + task.id);

    const cleared = tasksRepo.setWindowsTaskName(task.id, null);
    expect(cleared.windowsTaskName).toBeNull();
  });

  it('listScheduled only returns active tasks with schedule_enabled and a schedule_time set', () => {
    const scheduled = tasksRepo.createLocalFolder({ clientId, repositoryId, name: 'Scheduled', sourcePath: 'D:\\Sites\\acme\\a' });
    tasksRepo.createLocalFolder({ clientId, repositoryId, name: 'Unscheduled', sourcePath: 'D:\\Sites\\acme\\b' });
    tasksRepo.setSchedule(scheduled.id, { scheduleTime: '03:00', scheduleEnabled: true });

    expect(tasksRepo.listScheduled().map((t) => t.id)).toEqual([scheduled.id]);
  });
});
