export * from './types.js';
export * from './paths.js';

export { getDb, closeDb } from './db/connection.js';
export { runMigrations } from './db/migrate.js';

export { createClientsRepo } from './db/repositories/clientsRepo.js';
export type { ClientsRepo, CreateClientInput } from './db/repositories/clientsRepo.js';

export { createTransportsRepo } from './db/repositories/transportsRepo.js';
export type { TransportsRepo, CreateSftpTransportInput, CreateSshTransportInput } from './db/repositories/transportsRepo.js';

export { createDatabaseConnectionsRepo } from './db/repositories/databaseConnectionsRepo.js';
export type { DatabaseConnectionsRepo, CreateDatabaseConnectionInput } from './db/repositories/databaseConnectionsRepo.js';

export { createTasksRepo } from './db/repositories/tasksRepo.js';
export type {
  TasksRepo,
  CreateFetchExistingTaskInput,
  CreateRemoteDumpTaskInput,
  CreateDirectDumpTaskInput,
  SetScheduleInput,
} from './db/repositories/tasksRepo.js';

export { createRunsRepo } from './db/repositories/runsRepo.js';
export type { RunsRepo, CreateRunInput, SuccessfulFileSignature } from './db/repositories/runsRepo.js';

export { createRetentionDeletionsRepo } from './db/repositories/retentionDeletionsRepo.js';
export type { RetentionDeletionsRepo, CreateRetentionDeletionInput } from './db/repositories/retentionDeletionsRepo.js';

export { createKnownHostsRepo } from './db/repositories/knownHostsRepo.js';
export type { KnownHostsRepo } from './db/repositories/knownHostsRepo.js';

export { createLogEventsRepo } from './db/repositories/logEventsRepo.js';
export type { LogEventsRepo, LogEventLevel } from './db/repositories/logEventsRepo.js';

export { createSettingsRepo } from './db/repositories/settingsRepo.js';
export type { SettingsRepo } from './db/repositories/settingsRepo.js';

export type { SecretStore } from './secrets/types.js';
export { WindowsCredentialManagerStore } from './secrets/windowsCredentialManagerStore.js';

export * from './transports/types.js';
export { createSftpAdapter, createSftpAdapterFromTransport } from './transports/sftpAdapter.js';
export { createSshAdapter, createSshAdapterFromTransport } from './transports/sshAdapter.js';
export { buildHostVerifier } from './transports/hostKeyVerification.js';
export { resolveOutputPathTemplate } from './transports/outputPathTemplate.js';

export * from './databaseConnections/types.js';
export { createPostgresDumpClient } from './databaseConnections/postgresDumpClient.js';
export { createMysqlDumpClient } from './databaseConnections/mysqlDumpClient.js';
export { createPostgresConnectionTester } from './databaseConnections/postgresConnectionTester.js';
export { createMysqlConnectionTester } from './databaseConnections/mysqlConnectionTester.js';
export { testDatabaseConnection } from './databaseConnections/testDatabaseConnection.js';

export * from './strategies/types.js';
export { createFetchExistingExecutor } from './strategies/fetchExistingExecutor.js';
export { createRemoteDumpExecutor } from './strategies/remoteDumpExecutor.js';
export { createDirectDumpExecutor } from './strategies/directDumpExecutor.js';

export * from './validators/types.js';
export { createGenericValidator } from './validators/genericValidator.js';
export { createPostgresCustomValidator } from './validators/postgresCustomValidator.js';

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
  redactPassword,
} from './scheduler/windowsTaskScheduler.js';
export type { InstallScheduledTaskInput, ScheduledTaskStatus } from './scheduler/windowsTaskScheduler.js';

export { runBackupTask } from './orchestrator/runBackupTask.js';
export type { RunBackupTaskDeps, RunBackupTaskResult } from './orchestrator/runBackupTask.js';

export * from './config/types.js';
export { exportConfig } from './config/exportConfig.js';
export type { ExportConfigDeps } from './config/exportConfig.js';
export { importConfig } from './config/importConfig.js';
export type { ImportConfigDeps, ImportConfigResult, ImportedClientResult } from './config/importConfig.js';
