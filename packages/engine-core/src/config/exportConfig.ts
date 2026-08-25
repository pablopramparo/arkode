import { readFileSync } from 'node:fs';
import type { ClientsRepo } from '../db/repositories/clientsRepo.js';
import type { TransportsRepo } from '../db/repositories/transportsRepo.js';
import type { DatabaseConnectionsRepo } from '../db/repositories/databaseConnectionsRepo.js';
import type { TasksRepo } from '../db/repositories/tasksRepo.js';
import type { Transport, DatabaseConnection, BackupTask } from '../types.js';
import type {
  ConfigExport,
  ExportedClient,
  ExportedDatabaseConnection,
  ExportedTask,
  ExportedTaskBundle,
  ExportedTransport,
} from './types.js';

function readPrivateKeyBase64(privateKeyPath: string): string | null {
  try {
    return readFileSync(privateKeyPath).toString('base64');
  } catch {
    return null;
  }
}

function toExportedTransport(t: Transport): ExportedTransport {
  return {
    name: t.name,
    type: t.type,
    host: t.host,
    port: t.port,
    username: t.username,
    privateKeyPath: t.privateKeyPath,
    privateKeyContentBase64: t.privateKeyPath ? readPrivateKeyBase64(t.privateKeyPath) : null,
    hasPassphrase: t.passphraseSecretRef != null,
    hasPassword: t.passwordSecretRef != null,
    remotePath: t.remotePath,
    remoteFilePattern: t.remoteFilePattern,
    remoteCommand: t.remoteCommand,
    remoteOutputPathTemplate: t.remoteOutputPathTemplate,
    remoteCleanup: t.remoteCleanup,
    knownHostFingerprint: t.knownHostFingerprint,
  };
}

function toExportedDatabaseConnection(c: DatabaseConnection): ExportedDatabaseConnection {
  return {
    name: c.name,
    engine: c.engine,
    host: c.host,
    port: c.port,
    databaseName: c.databaseName,
    username: c.username,
    hasPassword: c.passwordSecretRef != null,
    sslMode: c.sslMode,
  };
}

function toExportedTask(task: BackupTask, transportName: string | null, databaseConnectionName: string | null): ExportedTask {
  return {
    name: task.name,
    strategy: task.strategy,
    transportName,
    databaseConnectionName,
    dbEngine: task.dbEngine,
    scheduleTime: task.scheduleTime,
    scheduleEnabled: task.scheduleEnabled,
    scheduleFrequency: task.scheduleFrequency,
    scheduleDaysOfWeek: task.scheduleDaysOfWeek,
    scheduleDayOfMonth: task.scheduleDayOfMonth,
    retentionCount: task.retentionCount,
    retentionDays: task.retentionDays,
  };
}

export interface ExportConfigDeps {
  clientsRepo: ClientsRepo;
  transportsRepo: TransportsRepo;
  databaseConnectionsRepo: DatabaseConnectionsRepo;
  tasksRepo: TasksRepo;
}

/** clientIds: specific client ids, or 'all' for every active client. */
export function exportConfig(clientIds: string[] | 'all', deps: ExportConfigDeps): ConfigExport {
  const clients = clientIds === 'all' ? deps.clientsRepo.listActive() : clientIds.map((id) => deps.clientsRepo.getById(id));

  const exportedClients: ExportedClient[] = [];
  for (const client of clients) {
    if (!client) continue; // an id that didn't resolve — caller already knows which ids it asked for
    exportedClients.push(exportOneClient(client.id, deps));
  }

  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    clients: exportedClients,
  };
}

function exportOneClient(clientId: string, deps: ExportConfigDeps): ExportedClient {
  const client = deps.clientsRepo.getById(clientId);
  if (!client) throw new Error(`Client ${clientId} not found.`);

  const transports = deps.transportsRepo.listByClient(clientId);
  const databaseConnections = deps.databaseConnectionsRepo.listByClient(clientId);
  const transportNameById = new Map(transports.map((t) => [t.id, t.name]));
  const databaseConnectionNameById = new Map(databaseConnections.map((c) => [c.id, c.name]));

  const exportedTransports = transports.map(toExportedTransport);
  const exportedDatabaseConnections = databaseConnections.map(toExportedDatabaseConnection);

  const exportedTasks: ExportedTask[] = deps.tasksRepo.listByClient(clientId).map((task) =>
    toExportedTask(
      task,
      task.transportId ? (transportNameById.get(task.transportId) ?? null) : null,
      task.databaseConnectionId ? (databaseConnectionNameById.get(task.databaseConnectionId) ?? null) : null
    )
  );

  return {
    name: client.name,
    description: client.description,
    localBasePath: client.localBasePath,
    retentionCount: client.retentionCount,
    retentionDays: client.retentionDays,
    transports: exportedTransports,
    databaseConnections: exportedDatabaseConnections,
    tasks: exportedTasks,
  };
}

/**
 * Exports one task plus the one transport or database connection it
 * depends on — a portable unit meant to be attached to an *existing*
 * client on a (possibly different) machine, unlike exportConfig()'s
 * client-scoped export, which always recreates a whole new client on
 * import. See ExportedTaskBundle's own doc comment and importTaskBundle().
 */
export function exportTask(taskId: string, deps: ExportConfigDeps): ExportedTaskBundle {
  const task = deps.tasksRepo.getById(taskId);
  if (!task) throw new Error(`Task ${taskId} not found.`);

  let transport: Transport | null = null;
  let databaseConnection: DatabaseConnection | null = null;
  if (task.transportId) {
    transport = deps.transportsRepo.getById(task.transportId);
    if (!transport) throw new Error(`Task ${taskId} references transport ${task.transportId}, which no longer exists.`);
  }
  if (task.databaseConnectionId) {
    databaseConnection = deps.databaseConnectionsRepo.getById(task.databaseConnectionId);
    if (!databaseConnection) {
      throw new Error(`Task ${taskId} references database connection ${task.databaseConnectionId}, which no longer exists.`);
    }
  }

  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    task: toExportedTask(task, transport?.name ?? null, databaseConnection?.name ?? null),
    transport: transport ? toExportedTransport(transport) : null,
    databaseConnection: databaseConnection ? toExportedDatabaseConnection(databaseConnection) : null,
  };
}
