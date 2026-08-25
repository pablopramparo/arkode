import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ClientsRepo } from '../db/repositories/clientsRepo.js';
import type { TransportsRepo } from '../db/repositories/transportsRepo.js';
import type { DatabaseConnectionsRepo } from '../db/repositories/databaseConnectionsRepo.js';
import type { TasksRepo } from '../db/repositories/tasksRepo.js';
import { keysDir as defaultKeysDir } from '../paths.js';
import type { ConfigExport, ExportedClient, ExportedDatabaseConnection, ExportedTask, ExportedTaskBundle, ExportedTransport } from './types.js';

export interface ImportConfigDeps {
  clientsRepo: ClientsRepo;
  transportsRepo: TransportsRepo;
  databaseConnectionsRepo: DatabaseConnectionsRepo;
  tasksRepo: TasksRepo;
  /** Directory to write restored SSH private key files into. Defaults to paths.keysDir(); override in tests to a temp dir. */
  importedKeysDir?: string;
}

/**
 * Resolves the private key path to actually use for an imported sftp/ssh
 * transport: writes the exported file content to a fresh file under
 * keysDir when available, or falls back to the source machine's own path
 * (almost certainly wrong here) — `needsManualCopy` is set in that
 * fallback case so the caller can flag it, but only once the transport is
 * actually created. Never called for ftp transports, which have no key at
 * all (see importTransport below).
 */
function resolveImportedPrivateKeyPath(
  t: ExportedTransport,
  importedKeysDir: string | undefined,
): { path: string; needsManualCopy?: string } {
  if (t.privateKeyContentBase64 == null) {
    return {
      path: t.privateKeyPath ?? '',
      needsManualCopy: `transport "${t.name}" — its private key file couldn't be included in the export (missing or unreadable at export time); copy "${t.privateKeyPath}" to this machine manually and update the transport's private key path`,
    };
  }
  // paths.keysDir() (the real machine app-data directory) is only ever
  // resolved here, in the one branch that actually writes a file — a
  // transport with no key content to restore (the common case in this
  // spec's own fixtures) must never touch it at all.
  const keysDir = importedKeysDir ?? defaultKeysDir();
  mkdirSync(keysDir, { recursive: true });
  const localPath = join(keysDir, `${randomUUID()}.key`);
  writeFileSync(localPath, Buffer.from(t.privateKeyContentBase64, 'base64'), { mode: 0o600 });
  return { path: localPath };
}

/**
 * Creates one transport under `clientId`, dispatching by type — shared by
 * importOneClient (client-scoped import) and importTaskBundle (single
 * task+connection import into an existing client), so the sftp/ssh
 * key-restore logic and the ftp/sftp/ssh field mapping exist in one place.
 */
function importTransport(t: ExportedTransport, clientId: string, deps: ImportConfigDeps): { id: string; secretNotes: string[] } {
  if (t.type === 'ftp') {
    const created = deps.transportsRepo.createFtp({
      clientId,
      name: t.name,
      host: t.host,
      port: t.port,
      username: t.username,
      remotePath: t.remotePath ?? '',
      remoteFilePattern: t.remoteFilePattern,
    });
    const secretNotes = t.hasPassword ? [`transport "${t.name}" needs its FTP password re-entered`] : [];
    return { id: created.id, secretNotes };
  }

  const { path: privateKeyPath, needsManualCopy } = resolveImportedPrivateKeyPath(t, deps.importedKeysDir);
  const created =
    t.type === 'sftp'
      ? deps.transportsRepo.createSftp({
          clientId,
          name: t.name,
          host: t.host,
          port: t.port,
          username: t.username,
          privateKeyPath,
          remotePath: t.remotePath ?? '',
          remoteFilePattern: t.remoteFilePattern,
          knownHostFingerprint: t.knownHostFingerprint,
        })
      : deps.transportsRepo.createSsh({
          clientId,
          name: t.name,
          host: t.host,
          port: t.port,
          username: t.username,
          privateKeyPath,
          remoteCommand: t.remoteCommand ?? '',
          remoteOutputPathTemplate: t.remoteOutputPathTemplate ?? '',
          remoteCleanup: t.remoteCleanup,
          knownHostFingerprint: t.knownHostFingerprint,
        });

  const secretNotes: string[] = [];
  if (t.hasPassphrase) secretNotes.push(`transport "${t.name}" needs its SSH key passphrase re-entered`);
  if (needsManualCopy) secretNotes.push(needsManualCopy);
  return { id: created.id, secretNotes };
}

function importDatabaseConnection(
  c: ExportedDatabaseConnection,
  clientId: string,
  deps: ImportConfigDeps,
): { id: string; secretNotes: string[] } {
  const created = deps.databaseConnectionsRepo.create({
    clientId,
    name: c.name,
    engine: c.engine,
    host: c.host,
    port: c.port,
    databaseName: c.databaseName,
    username: c.username,
    sslMode: c.sslMode,
  });
  const secretNotes = c.hasPassword ? [`database connection "${c.name}" needs its password re-entered`] : [];
  return { id: created.id, secretNotes };
}

export interface ImportedClientResult {
  name: string;
  /** null if the client itself failed to import (e.g. a client with this name already exists). */
  clientId: string | null;
  transportsCreated: number;
  databaseConnectionsCreated: number;
  tasksCreated: number;
  /** Human-readable list of transports/database connections that need a secret re-entered — never included in the export itself. */
  secretsNeedingReentry: string[];
  /** Any per-item failure (a task referencing an unresolvable transport, etc.) — the rest of the client's import still proceeds. */
  errors: string[];
}

export interface ImportConfigResult {
  clients: ImportedClientResult[];
}

/**
 * Imports a config export. Always creates new rows — never overwrites or
 * merges into an existing client. A client whose name already exists fails
 * with a clear error (surfaced per-client, not aborting the rest of the
 * batch); rename or remove the conflicting client first if you want to
 * re-import it.
 */
export function importConfig(data: ConfigExport, deps: ImportConfigDeps): ImportConfigResult {
  return { clients: data.clients.map((exported) => importOneClient(exported, deps)) };
}

function importOneClient(exported: ExportedClient, deps: ImportConfigDeps): ImportedClientResult {
  const result: ImportedClientResult = {
    name: exported.name,
    clientId: null,
    transportsCreated: 0,
    databaseConnectionsCreated: 0,
    tasksCreated: 0,
    secretsNeedingReentry: [],
    errors: [],
  };

  let clientId: string;
  try {
    const client = deps.clientsRepo.create({
      name: exported.name,
      description: exported.description,
      localBasePath: exported.localBasePath,
      retentionCount: exported.retentionCount,
      retentionDays: exported.retentionDays,
    });
    clientId = client.id;
    result.clientId = clientId;
  } catch (err) {
    result.errors.push(`Client "${exported.name}": ${err instanceof Error ? err.message : String(err)}`);
    return result; // nothing else can be created without a client
  }

  const transportIdByName = new Map<string, string>();
  for (const t of exported.transports) {
    try {
      const { id, secretNotes } = importTransport(t, clientId, deps);
      transportIdByName.set(t.name, id);
      result.transportsCreated++;
      result.secretsNeedingReentry.push(...secretNotes);
    } catch (err) {
      result.errors.push(`Transport "${t.name}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const databaseConnectionIdByName = new Map<string, string>();
  for (const c of exported.databaseConnections) {
    try {
      const { id, secretNotes } = importDatabaseConnection(c, clientId, deps);
      databaseConnectionIdByName.set(c.name, id);
      result.databaseConnectionsCreated++;
      result.secretsNeedingReentry.push(...secretNotes);
    } catch (err) {
      result.errors.push(`Database connection "${c.name}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  for (const task of exported.tasks) {
    try {
      const base = {
        clientId,
        name: task.name,
        dbEngine: task.dbEngine,
        retentionCount: task.retentionCount,
        retentionDays: task.retentionDays,
      };

      let created;
      if (task.strategy === 'direct_dump') {
        const databaseConnectionId = task.databaseConnectionName
          ? databaseConnectionIdByName.get(task.databaseConnectionName)
          : undefined;
        if (!databaseConnectionId) {
          throw new Error(`references database connection "${task.databaseConnectionName}", which was not imported`);
        }
        created = deps.tasksRepo.createDirectDump({ ...base, databaseConnectionId });
      } else {
        const transportId = task.transportName ? transportIdByName.get(task.transportName) : undefined;
        if (!transportId) {
          throw new Error(`references transport "${task.transportName}", which was not imported`);
        }
        created =
          task.strategy === 'remote_dump'
            ? deps.tasksRepo.createRemoteDump({ ...base, transportId })
            : deps.tasksRepo.createFetchExisting({ ...base, transportId });
      }

      if (task.scheduleTime) {
        deps.tasksRepo.setSchedule(created.id, {
          scheduleTime: task.scheduleTime,
          scheduleEnabled: task.scheduleEnabled,
          scheduleFrequency: task.scheduleFrequency,
          scheduleDaysOfWeek: task.scheduleDaysOfWeek,
          scheduleDayOfMonth: task.scheduleDayOfMonth,
        });
      }

      result.tasksCreated++;
    } catch (err) {
      result.errors.push(`Task "${task.name}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return result;
}

export interface ImportedTaskBundleResult {
  /** null if the task itself failed to import — its transport/database connection may still have been created (see transportCreated/databaseConnectionCreated). */
  taskId: string | null;
  transportCreated: boolean;
  databaseConnectionCreated: boolean;
  secretsNeedingReentry: string[];
  errors: string[];
}

/**
 * Imports a single-task export (see exportTask()) by attaching it to an
 * *existing* client, unlike importConfig() which always creates a brand
 * new client. The transport/database connection is created fresh under
 * that client (matched by nothing — always a new row, same "always
 * create, never merge" rule as importConfig()); if a same-named
 * transport/connection already exists on that client, this fails with the
 * same duplicate-name error the repo layer already raises elsewhere.
 */
export function importTaskBundle(bundle: ExportedTaskBundle, clientId: string, deps: ImportConfigDeps): ImportedTaskBundleResult {
  const result: ImportedTaskBundleResult = {
    taskId: null,
    transportCreated: false,
    databaseConnectionCreated: false,
    secretsNeedingReentry: [],
    errors: [],
  };

  if (!deps.clientsRepo.getById(clientId)) {
    result.errors.push(`Client ${clientId} not found.`);
    return result;
  }

  let transportId: string | undefined;
  let databaseConnectionId: string | undefined;

  if (bundle.transport) {
    try {
      const { id, secretNotes } = importTransport(bundle.transport, clientId, deps);
      transportId = id;
      result.transportCreated = true;
      result.secretsNeedingReentry.push(...secretNotes);
    } catch (err) {
      result.errors.push(`Transport "${bundle.transport.name}": ${err instanceof Error ? err.message : String(err)}`);
      return result; // the task can't be created without it
    }
  }

  if (bundle.databaseConnection) {
    try {
      const { id, secretNotes } = importDatabaseConnection(bundle.databaseConnection, clientId, deps);
      databaseConnectionId = id;
      result.databaseConnectionCreated = true;
      result.secretsNeedingReentry.push(...secretNotes);
    } catch (err) {
      result.errors.push(`Database connection "${bundle.databaseConnection.name}": ${err instanceof Error ? err.message : String(err)}`);
      return result;
    }
  }

  try {
    const task = bundle.task;
    const base = {
      clientId,
      name: task.name,
      dbEngine: task.dbEngine,
      retentionCount: task.retentionCount,
      retentionDays: task.retentionDays,
    };

    let created;
    if (task.strategy === 'direct_dump') {
      if (!databaseConnectionId) throw new Error('is missing its database connection');
      created = deps.tasksRepo.createDirectDump({ ...base, databaseConnectionId });
    } else {
      if (!transportId) throw new Error('is missing its transport');
      created =
        task.strategy === 'remote_dump'
          ? deps.tasksRepo.createRemoteDump({ ...base, transportId })
          : deps.tasksRepo.createFetchExisting({ ...base, transportId });
    }

    if (task.scheduleTime) {
      deps.tasksRepo.setSchedule(created.id, {
        scheduleTime: task.scheduleTime,
        scheduleEnabled: task.scheduleEnabled,
        scheduleFrequency: task.scheduleFrequency,
        scheduleDaysOfWeek: task.scheduleDaysOfWeek,
        scheduleDayOfMonth: task.scheduleDayOfMonth,
      });
    }

    result.taskId = created.id;
  } catch (err) {
    result.errors.push(`Task "${bundle.task.name}": ${err instanceof Error ? err.message : String(err)}`);
  }

  return result;
}
