import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../../../src/db/migrate.js';
import { migrationsSourceDir } from '../../../../src/paths.js';
import { createClientsRepo } from '../../../../src/db/repositories/clientsRepo.js';
import { createTransportsRepo } from '../../../../src/db/repositories/transportsRepo.js';
import { createFileBackupRepositoriesRepo } from '../../../../src/fileBackup/db/repositories/fileBackupRepositoriesRepo.js';
import { createFileBackupTasksRepo } from '../../../../src/fileBackup/db/repositories/fileBackupTasksRepo.js';
import { createFileBackupRunsRepo } from '../../../../src/fileBackup/db/repositories/fileBackupRunsRepo.js';
import { createFileBackupLogEventsRepo } from '../../../../src/fileBackup/db/repositories/fileBackupLogEventsRepo.js';

function seedRunId() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrationsSourceDir());

  const clientsRepo = createClientsRepo(db);
  const reposRepo = createFileBackupRepositoriesRepo(db);
  const tasksRepo = createFileBackupTasksRepo(db, createTransportsRepo(db));
  const runsRepo = createFileBackupRunsRepo(db);
  const logEventsRepo = createFileBackupLogEventsRepo(db);

  const client = clientsRepo.create({ name: 'client', localBasePath: 'D:\\Backups\\x' });
  const repository = reposRepo.create({ clientId: client.id, repoPath: 'D:\\Backups\\x\\_restic-repo', passwordSecretRef: 'ref' });
  const task = tasksRepo.createLocalFolder({ clientId: client.id, repositoryId: repository.id, name: 'task', sourcePath: 'D:\\Sites\\x' });
  const run = runsRepo.create({ taskId: task.id, clientId: client.id, repositoryId: repository.id, pid: 1 });

  return { runId: run.id, logEventsRepo };
}

describe('fileBackupLogEventsRepo', () => {
  it('inserts against a file_backup_runs id without a foreign-key error (the whole reason this table exists, not log_events)', () => {
    const { runId, logEventsRepo } = seedRunId();
    expect(() => logEventsRepo.append(runId, 'info', 'produce', 'running restic backup')).not.toThrow();
  });

  it('returns events newest first', () => {
    const { runId, logEventsRepo } = seedRunId();
    logEventsRepo.append(runId, 'info', 'connect', 'first');
    logEventsRepo.append(runId, 'info', 'produce', 'second');

    const { events } = logEventsRepo.listRecent();

    expect(events.map((e) => e.message)).toEqual(['second', 'first']);
  });

  it('filters by search/step/level', () => {
    const { runId, logEventsRepo } = seedRunId();
    logEventsRepo.append(runId, 'error', 'validate', 'Validation failed: empty snapshot');
    logEventsRepo.append(runId, 'info', 'result', 'File backup succeeded');

    expect(logEventsRepo.listRecent({ search: 'failed' }).events).toHaveLength(1);
    expect(logEventsRepo.listRecent({ step: 'validate' }).events).toHaveLength(1);
    expect(logEventsRepo.listRecent({ level: 'error' }).events).toHaveLength(1);
  });

  it('paginates with limit/offset while total reflects the full filtered count', () => {
    const { runId, logEventsRepo } = seedRunId();
    for (let i = 0; i < 5; i++) logEventsRepo.append(runId, 'info', 'connect', `line ${i}`);

    const page = logEventsRepo.listRecent({ limit: 2, offset: 0 });

    expect(page.events).toHaveLength(2);
    expect(page.total).toBe(5);
  });

  it('listDistinctSteps returns every step ever logged, sorted', () => {
    const { runId, logEventsRepo } = seedRunId();
    logEventsRepo.append(runId, 'info', 'produce', 'x');
    logEventsRepo.append(runId, 'info', 'connect', 'y');
    logEventsRepo.append(runId, 'info', 'connect', 'z');

    expect(logEventsRepo.listDistinctSteps()).toEqual(['connect', 'produce']);
  });
});
