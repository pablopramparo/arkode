import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ClientsRepo } from '../db/repositories/clientsRepo.js';
import type { TransportsRepo } from '../db/repositories/transportsRepo.js';
import type { DatabaseConnectionsRepo } from '../db/repositories/databaseConnectionsRepo.js';
import type { TasksRepo } from '../db/repositories/tasksRepo.js';
import { keysDir as defaultKeysDir } from '../paths.js';
import type { ConfigExport, ExportedClient, ExportedTransport } from './types.js';

export interface ImportConfigDeps {
  clientsRepo: ClientsRepo;
  transportsRepo: TransportsRepo;
  databaseConnectionsRepo: DatabaseConnectionsRepo;
  tasksRepo: TasksRepo;
  /** Directory to write restored SSH private key files into. Defaults to paths.keysDir(); override in tests to a temp dir. */
  importedKeysDir?: string;
}

/**
 * Resolves the private key path to actually use for the imported transport:
 * writes the exported file content to a fresh file under keysDir when
 * available, or falls back to the source machine's own path (almost
 * certainly wrong here) — `needsManualCopy` is set in that fallback case so
 * the caller can flag it, but only once the transport is actually created.
 */
function resolveImportedPrivateKeyPath(t: ExportedTransport, keysDir: string): { path: string; needsManualCopy?: string } {
  if (t.privateKeyContentBase64 == null) {
    return {
      path: t.privateKeyPath,
      needsManualCopy: `transport "${t.name}" — its private key file couldn't be included in the export (missing or unreadable at export time); copy "${t.privateKeyPath}" to this machine manually and update the transport's private key path`,
    };
  }
  mkdirSync(keysDir, { recursive: true });
  const localPath = join(keysDir, `${randomUUID()}.key`);
  writeFileSync(localPath, Buffer.from(t.privateKeyContentBase64, 'base64'), { mode: 0o600 });
  return { path: localPath };
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
      // Resolved per-transport, not once up front: a client with no
      // transports (or none needing a restored key) must never touch
      // paths.keysDir() at all — it resolves to the real machine app-data
      // directory when deps.importedKeysDir isn't overridden, which is
      // wrong both in tests (no PROGRAMDATA on a non-Windows CI runner) and
      // for an import that never actually restores a key.
      const keysDir = deps.importedKeysDir ?? defaultKeysDir();
      const { path: privateKeyPath, needsManualCopy } = resolveImportedPrivateKeyPath(t, keysDir);
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
      transportIdByName.set(t.name, created.id);
      result.transportsCreated++;
      if (t.hasPassphrase) {
        result.secretsNeedingReentry.push(`transport "${t.name}" needs its SSH key passphrase re-entered`);
      }
      if (needsManualCopy) {
        result.secretsNeedingReentry.push(needsManualCopy);
      }
    } catch (err) {
      result.errors.push(`Transport "${t.name}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const databaseConnectionIdByName = new Map<string, string>();
  for (const c of exported.databaseConnections) {
    try {
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
      databaseConnectionIdByName.set(c.name, created.id);
      result.databaseConnectionsCreated++;
      if (c.hasPassword) {
        result.secretsNeedingReentry.push(`database connection "${c.name}" needs its password re-entered`);
      }
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
