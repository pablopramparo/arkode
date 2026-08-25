import Database from 'better-sqlite3';
import { describe, expect, it, beforeEach } from 'vitest';
import { runMigrations } from '../../../../src/db/migrate.js';
import { migrationsSourceDir } from '../../../../src/paths.js';
import { createClientsRepo, type ClientsRepo } from '../../../../src/db/repositories/clientsRepo.js';
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
  let reposRepo: FileBackupRepositoriesRepo;
  let tasksRepo: FileBackupTasksRepo;
  let clientId: string;
  let repositoryId: string;

  beforeEach(() => {
    const db = freshDb();
    clientsRepo = createClientsRepo(db);
    reposRepo = createFileBackupRepositoriesRepo(db);
    tasksRepo = createFileBackupTasksRepo(db);
    clientId = clientsRepo.create({ name: 'Acme', localBasePath: 'D:\\Backups\\Acme' }).id;
    repositoryId = reposRepo.create({ clientId, repoPath: 'D:\\Backups\\Acme\\_restic-repo', passwordSecretRef: 'ref-1' }).id;
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

  it('update() only changes name/retention, never sourcePath/sourceKind/repositoryId', () => {
    const task = tasksRepo.createLocalFolder({ clientId, repositoryId, name: 'Uploads', sourcePath: 'D:\\Sites\\acme\\uploads' });
    const updated = tasksRepo.update(task.id, { name: 'Uploads renamed', retentionCount: 5 });
    expect(updated.name).toBe('Uploads renamed');
    expect(updated.retentionCount).toBe(5);
    expect(updated.sourcePath).toBe(task.sourcePath);
    expect(updated.repositoryId).toBe(task.repositoryId);
  });

  it('deactivate/reactivate round-trip', () => {
    const task = tasksRepo.createLocalFolder({ clientId, repositoryId, name: 'Uploads', sourcePath: 'D:\\Sites\\acme\\uploads' });
    tasksRepo.deactivate(task.id);
    expect(tasksRepo.getById(task.id)?.isActive).toBe(false);
    tasksRepo.reactivate(task.id);
    expect(tasksRepo.getById(task.id)?.isActive).toBe(true);
  });

  it('listByClient and listByRepository scope correctly', () => {
    const t1 = tasksRepo.createLocalFolder({ clientId, repositoryId, name: 'Uploads', sourcePath: 'D:\\Sites\\acme\\uploads' });
    const t2 = tasksRepo.createLocalFolder({ clientId, repositoryId, name: 'Docs', sourcePath: 'D:\\Sites\\acme\\docs' });
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

  it('listScheduled only returns active tasks with schedule_enabled and a schedule_time set', () => {
    const scheduled = tasksRepo.createLocalFolder({ clientId, repositoryId, name: 'Scheduled', sourcePath: 'D:\\Sites\\acme\\a' });
    tasksRepo.createLocalFolder({ clientId, repositoryId, name: 'Unscheduled', sourcePath: 'D:\\Sites\\acme\\b' });
    tasksRepo.setSchedule(scheduled.id, { scheduleTime: '03:00', scheduleEnabled: true });

    expect(tasksRepo.listScheduled().map((t) => t.id)).toEqual([scheduled.id]);
  });
});
