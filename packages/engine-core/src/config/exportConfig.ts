import type { ClientsRepo } from '../db/repositories/clientsRepo.js';
import type { TransportsRepo } from '../db/repositories/transportsRepo.js';
import type { DatabaseConnectionsRepo } from '../db/repositories/databaseConnectionsRepo.js';
import type { TasksRepo } from '../db/repositories/tasksRepo.js';
import type { ConfigExport, ExportedClient, ExportedDatabaseConnection, ExportedTask, ExportedTransport } from './types.js';

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

  const exportedTransports: ExportedTransport[] = transports.map((t) => ({
    name: t.name,
    type: t.type,
    host: t.host,
    port: t.port,
    username: t.username,
    privateKeyPath: t.privateKeyPath,
    hasPassphrase: t.passphraseSecretRef != null,
    remotePath: t.remotePath,
    remoteFilePattern: t.remoteFilePattern,
    remoteCommand: t.remoteCommand,
    remoteOutputPathTemplate: t.remoteOutputPathTemplate,
    remoteCleanup: t.remoteCleanup,
    knownHostFingerprint: t.knownHostFingerprint,
  }));

  const exportedDatabaseConnections: ExportedDatabaseConnection[] = databaseConnections.map((c) => ({
    name: c.name,
    engine: c.engine,
    host: c.host,
    port: c.port,
    databaseName: c.databaseName,
    username: c.username,
    hasPassword: c.passwordSecretRef != null,
    sslMode: c.sslMode,
  }));

  const exportedTasks: ExportedTask[] = deps.tasksRepo.listByClient(clientId).map((task) => ({
    name: task.name,
    strategy: task.strategy,
    transportName: task.transportId ? (transportNameById.get(task.transportId) ?? null) : null,
    databaseConnectionName: task.databaseConnectionId
      ? (databaseConnectionNameById.get(task.databaseConnectionId) ?? null)
      : null,
    dbEngine: task.dbEngine,
    scheduleTime: task.scheduleTime,
    scheduleEnabled: task.scheduleEnabled,
    retentionCount: task.retentionCount,
    retentionDays: task.retentionDays,
  }));

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
