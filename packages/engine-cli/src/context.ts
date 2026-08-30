import {
  getDb,
  runMigrations,
  createClientsRepo,
  createBackupSetsRepo,
  createTransportsRepo,
  createDatabaseConnectionsRepo,
  createTasksRepo,
  createRunsRepo,
  createKnownHostsRepo,
  createLogEventsRepo,
  createRetentionDeletionsRepo,
  createSettingsRepo,
  MachineDpapiSecretStore,
  createFileBackupRepositoriesRepo,
  createFileBackupTasksRepo,
  createFileBackupRunsRepo,
  createFileBackupRetentionDeletionsRepo,
  createFileBackupMaintenanceRunsRepo,
  createFileBackupLogEventsRepo,
  createReplicationTargetsRepo,
  createReplicationRunsRepo,
} from 'engine-core';

export function buildContext() {
  const db = getDb();
  runMigrations(db);

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
  const secretStore = new MachineDpapiSecretStore(db);

  // File backups (restic-backed) -- a domain parallel to the DB-backup one
  // above, deliberately not sharing repos/tables with it.
  const fileBackupRepositoriesRepo = createFileBackupRepositoriesRepo(db);
  const fileBackupTasksRepo = createFileBackupTasksRepo(db, transportsRepo);
  const fileBackupRunsRepo = createFileBackupRunsRepo(db);
  const fileBackupRetentionDeletionsRepo = createFileBackupRetentionDeletionsRepo(db);
  const fileBackupMaintenanceRunsRepo = createFileBackupMaintenanceRunsRepo(db);
  const fileBackupLogEventsRepo = createFileBackupLogEventsRepo(db);

  // Off-site replication to Google Drive (rclone) -- opt-in, runs after backups.
  const replicationTargetsRepo = createReplicationTargetsRepo(db);
  const replicationRunsRepo = createReplicationRunsRepo(db);

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
    fileBackupRetentionDeletionsRepo,
    fileBackupMaintenanceRunsRepo,
    fileBackupLogEventsRepo,
    replicationTargetsRepo,
    replicationRunsRepo,
  };
}

export type Context = ReturnType<typeof buildContext>;
