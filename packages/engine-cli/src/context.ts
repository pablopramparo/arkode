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
  createVaultMetaRepo,
  createVaultState,
  createVaultSecretStore,
  createVaultCredentialsRepo,
  createVaultUrlsRepo,
  createVaultItemsRepo,
  createVaultBackupTargetsRepo,
  throttleProgressSink,
  type ProgressSink,
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

  // Encrypted credential vault (Tier 2). The DEK lives only in this
  // process's memory once unlocked; a scheduled run in the arkode-scheduler
  // service never unlocks it (it reads Tier 1 DPAPI secrets instead).
  const vaultMetaRepo = createVaultMetaRepo(db);
  const autoLockMinutes = Number.parseInt(settingsRepo.get('vaultAutoLockMinutes') ?? '', 10);
  const vaultState = createVaultState({
    vaultMetaRepo,
    autoLockMs: Number.isFinite(autoLockMinutes) && autoLockMinutes > 0 ? autoLockMinutes * 60_000 : undefined,
  });
  const vaultSecretStore = createVaultSecretStore(db, vaultState);
  const vaultCredentialsRepo = createVaultCredentialsRepo(db);
  const vaultUrlsRepo = createVaultUrlsRepo(db);
  const vaultItemsRepo = createVaultItemsRepo(db);
  const vaultBackupTargetsRepo = createVaultBackupTargetsRepo(db);

  // Live-progress sinks: the orchestrators call onProgress(runId, progress)
  // repeatedly during a run; these throttle the writes (~1/s or on a real
  // change) and persist them to the run row, where the UI polls them. One
  // per process is enough — the throttle keeps per-run state internally.
  const dbProgressSink: ProgressSink = throttleProgressSink((runId, progress) => runsRepo.updateProgress(runId, progress));
  const fileProgressSink: ProgressSink = throttleProgressSink((runId, progress) =>
    fileBackupRunsRepo.updateProgress(runId, progress)
  );

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
    vaultMetaRepo,
    vaultState,
    vaultSecretStore,
    vaultCredentialsRepo,
    vaultUrlsRepo,
    vaultItemsRepo,
    vaultBackupTargetsRepo,
    dbProgressSink,
    fileProgressSink,
  };
}

export type Context = ReturnType<typeof buildContext>;
