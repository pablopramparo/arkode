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
export type { TasksRepo, CreateFetchExistingTaskInput, CreateRemoteDumpTaskInput } from './db/repositories/tasksRepo.js';

export { createRunsRepo } from './db/repositories/runsRepo.js';
export type { RunsRepo, CreateRunInput, SuccessfulFileSignature } from './db/repositories/runsRepo.js';

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

export * from './strategies/types.js';
export { createFetchExistingExecutor } from './strategies/fetchExistingExecutor.js';
export { createRemoteDumpExecutor } from './strategies/remoteDumpExecutor.js';
export { createDirectDumpExecutor } from './strategies/directDumpExecutor.js';

export * from './validators/types.js';
export { createGenericValidator } from './validators/genericValidator.js';
export { createPostgresCustomValidator } from './validators/postgresCustomValidator.js';

export { createRunLogger } from './logging/logger.js';
export type { RunLogger } from './logging/logger.js';

export { runBackupTask } from './orchestrator/runBackupTask.js';
export type { RunBackupTaskDeps, RunBackupTaskResult } from './orchestrator/runBackupTask.js';
