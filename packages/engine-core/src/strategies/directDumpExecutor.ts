import { join } from 'node:path';
import type { DatabaseConnection } from '../types.js';
import type { SecretStore } from '../secrets/types.js';
import type { SettingsRepo } from '../db/repositories/settingsRepo.js';
import type { DatabaseConnectionConfig, DatabaseDumpClient } from '../databaseConnections/types.js';
import { createPostgresDumpClient } from '../databaseConnections/postgresDumpClient.js';
import { createMysqlDumpClient } from '../databaseConnections/mysqlDumpClient.js';
import { createMariaDbDumpClient } from '../databaseConnections/mariaDbDumpClient.js';
import { createPostgresToolRegistry } from '../databaseConnections/postgresToolRegistry.js';
import { createMysqlToolRegistry } from '../databaseConnections/mysqlToolRegistry.js';
import { createMariaDbToolRegistry } from '../databaseConnections/mariaDbToolRegistry.js';
import type { BackupStrategyContext, BackupStrategyExecutor, ProducedDump } from './types.js';

const EXTENSION_BY_ENGINE: Record<DatabaseConnection['engine'], string> = {
  postgres: 'dump',
  mysql: 'sql',
  mariadb: 'sql', // mariadb-dump produces the same plain-SQL format as mysqldump
};

/**
 * `settingsRepo` is optional: when present, it backs a version-aware dump
 * tool registry for each engine (postgresToolRegistry.ts,
 * mysqlToolRegistry.ts, mariaDbToolRegistry.ts) that the respective dump
 * client consults before falling back to its one configured default
 * env-var path — an empty registry (the default, until entries are added
 * via `pg-tools:register`/`mysql-tools:register`/`mariadb-tools:register`)
 * changes nothing.
 */
function resolveDumpClient(engine: DatabaseConnection['engine'], settingsRepo?: SettingsRepo): DatabaseDumpClient {
  switch (engine) {
    case 'postgres':
      return createPostgresDumpClient(
        settingsRepo ? { registry: createPostgresToolRegistry(settingsRepo) } : undefined
      );
    case 'mysql':
      return createMysqlDumpClient(settingsRepo ? { registry: createMysqlToolRegistry(settingsRepo) } : undefined);
    case 'mariadb':
      return createMariaDbDumpClient(settingsRepo ? { registry: createMariaDbToolRegistry(settingsRepo) } : undefined);
  }
}

function timestampSuffix(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/**
 * Connects directly to Postgres/MySQL from this PC using SecretStore-held
 * credentials and runs the local dump client — no transport at all, since
 * there's no separate file-transfer step (the dump lands on local disk
 * directly). Every invocation legitimately produces a fresh file, so
 * there's no "already downloaded" case to detect, same as remote_dump.
 */
export function createDirectDumpExecutor(
  databaseConnection: DatabaseConnection,
  secretStore: SecretStore,
  settingsRepo?: SettingsRepo
): BackupStrategyExecutor {
  return {
    kind: 'direct_dump',

    async produce(ctx: BackupStrategyContext): Promise<ProducedDump> {
      const password = databaseConnection.passwordSecretRef
        ? (secretStore.get(databaseConnection.passwordSecretRef) ?? undefined)
        : undefined;

      const dumpClient = resolveDumpClient(databaseConnection.engine, settingsRepo);
      const now = new Date();
      const extension = EXTENSION_BY_ENGINE[databaseConnection.engine];
      const fileName = `${databaseConnection.databaseName}_${timestampSuffix(now)}.${extension}`;
      const localTempPath = join(ctx.targetDir, `${fileName}.part`);

      const config: DatabaseConnectionConfig = {
        engine: databaseConnection.engine,
        host: databaseConnection.host,
        port: databaseConnection.port,
        databaseName: databaseConnection.databaseName,
        username: databaseConnection.username,
        password,
        sslMode: databaseConnection.sslMode
          ? (databaseConnection.sslMode as DatabaseConnectionConfig['sslMode'])
          : undefined,
      };

      const result = await dumpClient.dump(config, localTempPath);

      if (result.sizeBytes <= 0) {
        throw new Error(`Produced dump "${fileName}" is empty (0 bytes).`);
      }

      return {
        localTempPath,
        fileName,
        sizeBytes: result.sizeBytes,
        // Locally generated, so always trustworthy — unlike the remote-mtime
        // caveat that applies to fetch_existing/remote_dump.
        sourceModifiedAt: now,
        // Left undefined deliberately: pg_dump/mysqldump write straight to
        // disk via subprocess redirection, so there's no stream here to hash
        // incrementally. The orchestrator's fallback hashes the temp file
        // once instead — see the checksum responsibility split in
        // strategies/types.ts.
      };
    },
  };
}
