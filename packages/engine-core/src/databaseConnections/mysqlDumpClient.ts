import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat } from 'node:fs/promises';
import type { DatabaseDumpClient, DatabaseConnectionConfig } from './types.js';
import type { MysqlToolRegistry } from './mysqlToolRegistry.js';
import { resolveToolPath } from '../toolPaths.js';
import {
  isMariaDbBinary,
  mysqlBinaryExtraArgs,
  mysqlFamilySslArgs,
  resolveMysqlFamilyCli,
} from './mysqlClientResolution.js';

const execFileAsync = promisify(execFile);

export interface MysqlDumpClientDeps {
  /** Fallback dump-tool path, used whenever the registry has no match (or isn't provided at all). Defaults to MYSQLDUMP_PATH, then the bundled mariadb-dump. */
  defaultMysqldumpPath?: string;
  /** Needed to query the server's own version before dumping, so the registry can pick a matching tool. Defaults to MYSQL_CLI_PATH, then the bundled MariaDB client. */
  mysqlPath?: string;
  /** See mysqlToolRegistry.ts. Omit to always use the default path. */
  registry?: MysqlToolRegistry;
}

/**
 * Args every invocation of `binPath` needs against `config`: SSL flags in
 * the syntax that binary's flavor accepts (`mysqldump` → `--ssl-mode=X`;
 * `mariadb-dump` → `--ssl`/`--skip-ssl`), plus `--plugin-dir` when it's the
 * bundled MariaDB binary (needed to auth to a caching_sha2_password MySQL
 * server).
 */
function connectionArgs(binPath: string, config: DatabaseConnectionConfig): string[] {
  const flavor = isMariaDbBinary(binPath) ? 'mariadb' : 'mysql';
  return [
    ...mysqlBinaryExtraArgs(binPath),
    '--host',
    config.host,
    '--port',
    String(config.port),
    '--user',
    config.username,
    ...mysqlFamilySslArgs(flavor, config.sslMode),
  ];
}

/** Best-effort — a failure here just means falling back to the default dump path, never blocks the dump itself. */
async function detectServerVersion(
  cliPath: string,
  config: DatabaseConnectionConfig,
  env: NodeJS.ProcessEnv
): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      cliPath,
      [...connectionArgs(cliPath, config), '--batch', '--skip-column-names', '--execute=SELECT VERSION()', config.databaseName],
      { env }
    );
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Produces a plain-SQL dump of a MySQL server. Prefers a real `mysqldump`
 * (an explicit MYSQLDUMP_PATH, or a version-matched entry in
 * `mysqlToolRegistry` — see that file), but falls back to the bundled
 * `mariadb-dump` (arkode ships MariaDB's tools, not Oracle's) so a
 * `direct_dump` of a MySQL server needs zero configuration. Either tool's
 * output validates the same (mysqlDumpValidator covers both).
 *
 * The password goes via the MYSQL_PWD environment variable, never argv, for
 * the same reason as pg_dump's PGPASSWORD.
 */
export function createMysqlDumpClient(deps: MysqlDumpClientDeps = {}): DatabaseDumpClient {
  // A real mysqldump first (an explicit path or MYSQLDUMP_PATH), then the
  // MariaDB dumper — MARIADB_DUMP_PATH (what lib.rs sets on a real install)
  // or the copy vendored next to engine-cli.exe. arkode ships MariaDB's
  // tools, not Oracle's.
  const fallbackDumpPath =
    deps.defaultMysqldumpPath ??
    resolveToolPath('MYSQLDUMP_PATH', 'mysqldump.exe') ??
    resolveToolPath('MARIADB_DUMP_PATH', 'mariadb-dump.exe');
  const cli = resolveMysqlFamilyCli(deps.mysqlPath);
  const registry = deps.registry;

  return {
    engine: 'mysql',
    async dump(config: DatabaseConnectionConfig, localTempPath: string): Promise<{ sizeBytes: number }> {
      const env: NodeJS.ProcessEnv = { ...process.env };
      if (config.password) env.MYSQL_PWD = config.password;

      let dumpPath = fallbackDumpPath;
      if (registry && cli) {
        const serverVersion = await detectServerVersion(cli.path, config, env);
        const resolved = serverVersion ? registry.resolve(serverVersion) : null;
        if (resolved) dumpPath = resolved.mysqldumpPath;
      }

      if (!dumpPath) {
        throw new Error(
          'No hay una herramienta de dump para MySQL disponible — configurá MYSQLDUMP_PATH, registrá una versión, o reinstalá arkode (trae mariadb-dump incluido).'
        );
      }

      const args = [...connectionArgs(dumpPath, config), `--result-file=${localTempPath}`, config.databaseName];

      try {
        await execFileAsync(dumpPath, args, { env });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`mysqldump failed: ${message}`);
      }

      const fileStat = await stat(localTempPath);
      return { sizeBytes: fileStat.size };
    },
  };
}
