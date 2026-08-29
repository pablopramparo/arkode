import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/migrate.js';
import { migrationsSourceDir } from '../../src/paths.js';
import { createClientsRepo } from '../../src/db/repositories/clientsRepo.js';
import { createBackupSetsRepo } from '../../src/db/repositories/backupSetsRepo.js';
import { createTransportsRepo } from '../../src/db/repositories/transportsRepo.js';
import { createDatabaseConnectionsRepo } from '../../src/db/repositories/databaseConnectionsRepo.js';
import { createTasksRepo } from '../../src/db/repositories/tasksRepo.js';
import { createRunsRepo } from '../../src/db/repositories/runsRepo.js';
import { createKnownHostsRepo } from '../../src/db/repositories/knownHostsRepo.js';
import { createLogEventsRepo } from '../../src/db/repositories/logEventsRepo.js';
import { createRetentionDeletionsRepo } from '../../src/db/repositories/retentionDeletionsRepo.js';
import { createSettingsRepo } from '../../src/db/repositories/settingsRepo.js';
import { createFileBackupRepositoriesRepo } from '../../src/fileBackup/db/repositories/fileBackupRepositoriesRepo.js';
import { createFileBackupTasksRepo } from '../../src/fileBackup/db/repositories/fileBackupTasksRepo.js';
import { createFileBackupRunsRepo } from '../../src/fileBackup/db/repositories/fileBackupRunsRepo.js';
import { createFileBackupMaintenanceRunsRepo } from '../../src/fileBackup/db/repositories/fileBackupMaintenanceRunsRepo.js';
import { createFileBackupRetentionDeletionsRepo } from '../../src/fileBackup/db/repositories/fileBackupRetentionDeletionsRepo.js';
import { createFileBackupLogEventsRepo } from '../../src/fileBackup/db/repositories/fileBackupLogEventsRepo.js';
import type { SecretStore } from '../../src/secrets/types.js';

/** In-memory Map-based SecretStore — never touches the real Windows Credential Manager in tests. */
export function createFakeSecretStore(): SecretStore {
  const store = new Map<string, string>();
  return {
    get: (ref) => store.get(ref) ?? null,
    set: (ref, value) => void store.set(ref, value),
    delete: (ref) => void store.delete(ref),
  };
}

/**
 * A fresh in-memory SQLite DB with migrations applied and every repo wired
 * up — mirrors engine-cli's buildContext() but for tests, with no real
 * filesystem/network/OS dependency for the DB itself.
 */
export function createTestContext() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrationsSourceDir());

  const clientsRepo = createClientsRepo(db);
  const backupSetsRepo = createBackupSetsRepo(db);
  const transportsRepo = createTransportsRepo(db);
  const databaseConnectionsRepo = createDatabaseConnectionsRepo(db);
  const tasksRepo = createTasksRepo(db, transportsRepo, databaseConnectionsRepo);
  const runsRepo = createRunsRepo(db);
  const knownHostsRepo = createKnownHostsRepo(db);
  const logEventsRepo = createLogEventsRepo(db);
  const retentionDeletionsRepo = createRetentionDeletionsRepo(db);
  const settingsRepo = createSettingsRepo(db);
  const secretStore = createFakeSecretStore();
  const fileBackupRepositoriesRepo = createFileBackupRepositoriesRepo(db);
  const fileBackupTasksRepo = createFileBackupTasksRepo(db, transportsRepo);
  const fileBackupRunsRepo = createFileBackupRunsRepo(db);
  const fileBackupMaintenanceRunsRepo = createFileBackupMaintenanceRunsRepo(db);
  const fileBackupRetentionDeletionsRepo = createFileBackupRetentionDeletionsRepo(db);
  const fileBackupLogEventsRepo = createFileBackupLogEventsRepo(db);

  return {
    db,
    clientsRepo,
    backupSetsRepo,
    transportsRepo,
    databaseConnectionsRepo,
    tasksRepo,
    runsRepo,
    knownHostsRepo,
    logEventsRepo,
    retentionDeletionsRepo,
    settingsRepo,
    secretStore,
    fileBackupRepositoriesRepo,
    fileBackupTasksRepo,
    fileBackupRunsRepo,
    fileBackupMaintenanceRunsRepo,
    fileBackupRetentionDeletionsRepo,
    fileBackupLogEventsRepo,
  };
}

export type TestContext = ReturnType<typeof createTestContext>;
