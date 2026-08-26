export * from './types.js';
export * from './paths.js';

export { getDb, closeDb } from './db/connection.js';
export { runMigrations } from './db/migrate.js';

export { createClientsRepo } from './db/repositories/clientsRepo.js';
export type { ClientsRepo, CreateClientInput, UpdateClientInput } from './db/repositories/clientsRepo.js';

export { createTransportsRepo } from './db/repositories/transportsRepo.js';
export type {
  TransportsRepo,
  CreateSftpTransportInput,
  CreateSshTransportInput,
  UpdateTransportInput,
} from './db/repositories/transportsRepo.js';

export { createDatabaseConnectionsRepo } from './db/repositories/databaseConnectionsRepo.js';
export type {
  DatabaseConnectionsRepo,
  CreateDatabaseConnectionInput,
  UpdateDatabaseConnectionInput,
} from './db/repositories/databaseConnectionsRepo.js';

export { createTasksRepo } from './db/repositories/tasksRepo.js';
export type {
  TasksRepo,
  CreateFetchExistingTaskInput,
  CreateRemoteDumpTaskInput,
  CreateDirectDumpTaskInput,
  SetScheduleInput,
  UpdateTaskInput,
} from './db/repositories/tasksRepo.js';

export { createRunsRepo } from './db/repositories/runsRepo.js';
export type { RunsRepo, CreateRunInput, SuccessfulFileSignature, ListBackupsOptions } from './db/repositories/runsRepo.js';

export { createRetentionDeletionsRepo } from './db/repositories/retentionDeletionsRepo.js';
export type { RetentionDeletionsRepo, CreateRetentionDeletionInput } from './db/repositories/retentionDeletionsRepo.js';

export { createKnownHostsRepo } from './db/repositories/knownHostsRepo.js';
export type { KnownHostsRepo } from './db/repositories/knownHostsRepo.js';

export { createLogEventsRepo } from './db/repositories/logEventsRepo.js';
export type { LogEventsRepo, LogEvent, LogEventLevel, ListLogEventsOptions } from './db/repositories/logEventsRepo.js';

export { createSettingsRepo } from './db/repositories/settingsRepo.js';
export type { SettingsRepo } from './db/repositories/settingsRepo.js';

export type { SecretStore } from './secrets/types.js';
export { MachineDpapiSecretStore } from './secrets/machineDpapiStore.js';

export * from './transports/types.js';
export { createSftpAdapter, createSftpAdapterFromTransport } from './transports/sftpAdapter.js';
export { createSshAdapter, createSshAdapterFromTransport } from './transports/sshAdapter.js';
export { createFtpAdapter, createFtpAdapterFromTransport } from './transports/ftpAdapter.js';
export { buildHostVerifier } from './transports/hostKeyVerification.js';
export { resolveOutputPathTemplate } from './transports/outputPathTemplate.js';
export { copyPrivateKeyIntoAppStorage } from './transports/copyPrivateKey.js';

export * from './databaseConnections/types.js';
export { createPostgresDumpClient } from './databaseConnections/postgresDumpClient.js';
export { createMysqlDumpClient } from './databaseConnections/mysqlDumpClient.js';
export { createMariaDbDumpClient } from './databaseConnections/mariaDbDumpClient.js';
export { createPostgresConnectionTester } from './databaseConnections/postgresConnectionTester.js';
export { createMysqlConnectionTester } from './databaseConnections/mysqlConnectionTester.js';
export { testDatabaseConnection } from './databaseConnections/testDatabaseConnection.js';
export { createPostgresToolRegistry, extractMajorVersion } from './databaseConnections/postgresToolRegistry.js';
export type { PostgresToolRegistry, PostgresToolPaths } from './databaseConnections/postgresToolRegistry.js';
export { createMysqlToolRegistry, extractMysqlMajorMinorVersion } from './databaseConnections/mysqlToolRegistry.js';
export type { MysqlToolRegistry, MysqlToolPaths } from './databaseConnections/mysqlToolRegistry.js';
export { createMariaDbToolRegistry, extractMariaDbMajorMinorVersion } from './databaseConnections/mariaDbToolRegistry.js';
export type { MariaDbToolRegistry, MariaDbToolPaths } from './databaseConnections/mariaDbToolRegistry.js';
export { testDirectDumpCompatibility } from './databaseConnections/testDirectDumpCompatibility.js';
export type { DirectDumpCompatibilityResult, ToolCompatibility } from './databaseConnections/testDirectDumpCompatibility.js';
export { downloadTool } from './databaseConnections/downloadTool.js';
export type { DownloadableEngine, DownloadToolInput } from './databaseConnections/downloadTool.js';

export * from './strategies/types.js';
export { createFetchExistingExecutor } from './strategies/fetchExistingExecutor.js';
export { createRemoteDumpExecutor } from './strategies/remoteDumpExecutor.js';
export { createDirectDumpExecutor } from './strategies/directDumpExecutor.js';

export * from './validators/types.js';
export { createGenericValidator } from './validators/genericValidator.js';
export { createPostgresCustomValidator } from './validators/postgresCustomValidator.js';
export { createMysqlDumpValidator } from './validators/mysqlDumpValidator.js';

export { createRunLogger } from './logging/logger.js';
export type { RunLogger } from './logging/logger.js';

export { applyRetention, resolveRetentionPolicy } from './retention/applyRetention.js';
export type { RetentionPolicy, ApplyRetentionDeps } from './retention/applyRetention.js';

export { isTaskDue } from './scheduler/isTaskDue.js';
export { runDueTasks } from './scheduler/runDueTasks.js';
export type { RunDueResult } from './scheduler/runDueTasks.js';
export { buildTaskDefinitionXml } from './scheduler/taskDefinitionXml.js';
export type { TaskDefinitionInput } from './scheduler/taskDefinitionXml.js';
export {
  scheduledTaskNameForBackupTask,
  installScheduledTask,
  uninstallScheduledTask,
  scheduledTaskStatus,
} from './scheduler/windowsTaskScheduler.js';
export type { InstallScheduledTaskInput, ScheduledTaskStatus } from './scheduler/windowsTaskScheduler.js';

export { getDashboardStatus } from './status/getDashboardStatus.js';
export type { DashboardRow, GetDashboardStatusDeps } from './status/getDashboardStatus.js';

export { getSystemInfo } from './status/getSystemInfo.js';
export type { SystemInfo, ToolPathStatus } from './status/getSystemInfo.js';

export { runBackupTask } from './orchestrator/runBackupTask.js';
export type { RunBackupTaskDeps, RunBackupTaskResult } from './orchestrator/runBackupTask.js';

export * from './config/types.js';
export { exportConfig, exportTask } from './config/exportConfig.js';
export type { ExportConfigDeps } from './config/exportConfig.js';
export { importConfig, importTaskBundle } from './config/importConfig.js';
export type { ImportConfigDeps, ImportConfigResult, ImportedClientResult, ImportedTaskBundleResult } from './config/importConfig.js';

// --- File backups (restic-backed), a domain parallel to the DB-backup one
// above -- deliberately its own tables/orchestrator/scheduler/retention, not
// sharing code with backup_tasks/backup_runs. See fileBackup/types.ts and
// CLAUDE.md's file-backup design notes for the full reasoning.
export * from './fileBackup/types.js';

export { createFileBackupRepositoriesRepo } from './fileBackup/db/repositories/fileBackupRepositoriesRepo.js';
export type {
  FileBackupRepositoriesRepo,
  CreateFileBackupRepositoryInput,
} from './fileBackup/db/repositories/fileBackupRepositoriesRepo.js';

export { createFileBackupTasksRepo } from './fileBackup/db/repositories/fileBackupTasksRepo.js';
export type {
  FileBackupTasksRepo,
  CreateLocalFolderTaskInput,
  CreateRemoteFolderTaskInput,
  SetFileBackupScheduleInput,
  UpdateFileBackupTaskInput,
} from './fileBackup/db/repositories/fileBackupTasksRepo.js';

export { createFileBackupRunsRepo } from './fileBackup/db/repositories/fileBackupRunsRepo.js';
export type {
  FileBackupRunsRepo,
  CreateFileBackupRunInput,
  RecordBackupSummaryInput,
} from './fileBackup/db/repositories/fileBackupRunsRepo.js';

export { createFileBackupRetentionDeletionsRepo } from './fileBackup/db/repositories/fileBackupRetentionDeletionsRepo.js';
export type {
  FileBackupRetentionDeletionsRepo,
  CreateFileBackupRetentionDeletionInput,
} from './fileBackup/db/repositories/fileBackupRetentionDeletionsRepo.js';

export { createFileBackupMaintenanceRunsRepo } from './fileBackup/db/repositories/fileBackupMaintenanceRunsRepo.js';
export type {
  FileBackupMaintenanceRunsRepo,
  CreateFileBackupMaintenanceRunInput,
} from './fileBackup/db/repositories/fileBackupMaintenanceRunsRepo.js';

export { createFileBackupLogEventsRepo } from './fileBackup/db/repositories/fileBackupLogEventsRepo.js';
export type { FileBackupLogEventsRepo } from './fileBackup/db/repositories/fileBackupLogEventsRepo.js';

export { toResticPath, fromResticPath } from './fileBackup/restic/paths.js';
export * as resticClient from './fileBackup/restic/resticClient.js';
export { RESTIC_HOST, buildForgetArgs } from './fileBackup/restic/resticClient.js';

export { checkRepositoryLock, recoverStaleRepositoryRuns } from './fileBackup/locking/repositoryLock.js';
export type { FileBackupOperationKind, RepositoryLockDeps, RepositoryLockResult } from './fileBackup/locking/repositoryLock.js';

export { createFileBackupRunLogger } from './fileBackup/logging/createFileBackupRunLogger.js';
export type { FileBackupRunLogger } from './fileBackup/logging/createFileBackupRunLogger.js';

export { createFileBackupRepository, exportFileBackupRepositoryKey } from './fileBackup/createFileBackupRepository.js';
export type { CreateFileBackupRepositoryDeps, CreateFileBackupRepositoryResult } from './fileBackup/createFileBackupRepository.js';

export { restoreFileBackupRun, restoreFileBackupFile } from './fileBackup/restoreFileBackup.js';
export type { RestoreFileBackupDeps } from './fileBackup/restoreFileBackup.js';

export { runFileBackupTask } from './fileBackup/orchestrator/runFileBackupTask.js';
export type { RunFileBackupTaskDeps, RunFileBackupTaskResult } from './fileBackup/orchestrator/runFileBackupTask.js';

export { applyFileBackupRetention, resolveFileBackupRetentionPolicy } from './fileBackup/retention/applyFileBackupRetention.js';
export type { FileBackupRetentionPolicy, ApplyFileBackupRetentionDeps } from './fileBackup/retention/applyFileBackupRetention.js';

export { syncRemoteFolder } from './fileBackup/remoteSync/syncRemoteFolder.js';
export type { SyncRemoteFolderAdapter, SyncRemoteFolderResult } from './fileBackup/remoteSync/syncRemoteFolder.js';

export { runFileBackupMaintenance } from './fileBackup/maintenance/runFileBackupMaintenance.js';
export type {
  RunFileBackupMaintenanceDeps,
  RunFileBackupMaintenanceOpts,
  FileBackupMaintenanceOutcome,
} from './fileBackup/maintenance/runFileBackupMaintenance.js';

export { isFileBackupTaskDue } from './fileBackup/scheduler/isFileBackupTaskDue.js';
export { runFileBackupDueTasks } from './fileBackup/scheduler/runFileBackupDueTasks.js';
export type { FileBackupRunDueResult } from './fileBackup/scheduler/runFileBackupDueTasks.js';
