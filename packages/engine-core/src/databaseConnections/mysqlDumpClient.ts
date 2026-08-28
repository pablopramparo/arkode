import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat } from 'node:fs/promises';
import { resolveToolPath } from '../toolPaths.js';
import type { DatabaseDumpClient, DatabaseConnectionConfig } from './types.js';
import type { MysqlToolRegistry } from './mysqlToolRegistry.js';
import { resolveMysqlFamilyCli } from './mysqlClientResolution.js';

const execFileAsync = promisify(execFile);

const SSL_MODE_FLAG: Record<NonNullable<DatabaseConnectionConfig['sslMode']>, string> = {
  disable: 'DISABLED',
  require: 'REQUIRED',
  'verify-full': 'VERIFY_IDENTITY',
};

export interface MysqlDumpClientDeps {
  /** Fallback mysqldump path, used whenever the registry has no match (or isn't provided at all). Defaults to MYSQLDUMP_PATH. */
  defaultMysqldumpPath?: string;
  /** Needed to query the server's own version before dumping, so the registry can pick a matching tool. Defaults to MYSQL_CLI_PATH — the same `mysql` client binary used for connection testing. Without this, version-aware resolution is skipped entirely and defaultMysqldumpPath is always used. */
  mysqlPath?: string;
  /** See mysqlToolRegistry.ts. Omit to always use defaultMysqldumpPath, unchanged from this client's original single-path behavior. */
  registry?: MysqlToolRegistry;
}

function baseArgs(config: DatabaseConnectionConfig): string[] {
  const args = ['--host', config.host, '--port', String(config.port), '--user', config.username];
  if (config.sslMode) args.push(`--ssl-mode=${SSL_MODE_FLAG[config.sslMode]}`);
  return args;
}

/** Best-effort — a failure here (missing mysqlPath, connection error, whatever) just means falling back to the default path, never blocks the dump itself. */
async function detectServerVersion(mysqlPath: string, config: DatabaseConnectionConfig, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      mysqlPath,
      [...baseArgs(config), '--batch', '--skip-column-names', '--execute=SELECT VERSION()', config.databaseName],
      { env }
    );
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Shells out to a local `mysqldump` (dev-time path via MYSQLDUMP_PATH env
 * var — same pattern as pg_dump/pg_restore). mysqldump's client tools are
 * GPLv2, unlike PostgreSQL's permissive license; per the agreed increment
 * this is implemented dev-time-only, with the installer-bundling/licensing
 * decision deferred to packaging.
 *
 * If both `registry` and `mysqlPath` are given, resolves which mysqldump to
 * actually run based on the target server's own detected major.minor
 * version (see mysqlToolRegistry.ts) — falling back to `defaultMysqldumpPath`
 * (i.e. MYSQLDUMP_PATH) whenever no matching entry is registered, the
 * version can't be detected, or no registry/mysqlPath was supplied at all.
 * Calling this with no arguments behaves identically to before this
 * existed: always the one configured MYSQLDUMP_PATH, no version query ever
 * attempted.
 *
 * The password is passed via the MYSQL_PWD environment variable, never as a
 * CLI argument, for the same reason as pg_dump's PGPASSWORD.
 */
export function createMysqlDumpClient(deps: MysqlDumpClientDeps = {}): DatabaseDumpClient {
  // No bundled fallback here on purpose: arkode ships mariadb-dump, not
  // Oracle's mysqldump. directDumpExecutor.ts routes a `mysql`-engine task
  // to the MariaDB dumper when no real mysqldump is configured.
  const defaultMysqldumpPath = deps.defaultMysqldumpPath ?? resolveToolPath('MYSQLDUMP_PATH', 'mysqldump.exe');
  const mysqlPath = deps.mysqlPath ?? resolveMysqlFamilyCli()?.path;
  const registry = deps.registry;

  return {
    engine: 'mysql',
    async dump(config: DatabaseConnectionConfig, localTempPath: string): Promise<{ sizeBytes: number }> {
      const env: NodeJS.ProcessEnv = { ...process.env };
      if (config.password) env.MYSQL_PWD = config.password;

      let mysqldumpPath = defaultMysqldumpPath;
      if (registry && mysqlPath) {
        const serverVersion = await detectServerVersion(mysqlPath, config, env);
        const resolved = serverVersion ? registry.resolve(serverVersion) : null;
        if (resolved) mysqldumpPath = resolved.mysqldumpPath;
      }

      if (!mysqldumpPath) {
        throw new Error('MYSQLDUMP_PATH is not configured — cannot run mysqldump.');
      }

      const args = [...baseArgs(config), `--result-file=${localTempPath}`, config.databaseName];

      try {
        await execFileAsync(mysqldumpPath, args, { env });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`mysqldump failed: ${message}`);
      }

      const fileStat = await stat(localTempPath);
      return { sizeBytes: fileStat.size };
    },
  };
}
