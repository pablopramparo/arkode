import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat } from 'node:fs/promises';
import type { DatabaseDumpClient, DatabaseConnectionConfig } from './types.js';
import type { MariaDbToolRegistry } from './mariaDbToolRegistry.js';

const execFileAsync = promisify(execFile);

/**
 * MariaDB's own `mariadb-dump` uses a different SSL flag set than MySQL's
 * `mysqldump` — confirmed by hand against a real local install (`mariadb-dump
 * --help`), not assumed from mysqldump's docs: no `--ssl-mode=X` at all, just
 * a boolean `--ssl`/`--skip-ssl` plus separate cert/key/CA flags. This is
 * exactly the kind of MySQL-vs-MariaDB divergence that's the whole reason
 * this client isn't just "call mysqldump and rename it" — see the module
 * comment below.
 */
const SSL_ARGS: Record<NonNullable<DatabaseConnectionConfig['sslMode']>, string[]> = {
  disable: ['--skip-ssl'],
  require: ['--ssl'],
  'verify-full': ['--ssl', '--ssl-verify-server-cert'],
};

export interface MariaDbDumpClientDeps {
  /** Fallback mariadb-dump path, used whenever the registry has no match (or isn't provided at all). Defaults to MARIADB_DUMP_PATH. */
  defaultMariaDbDumpPath?: string;
  /** Needed to query the server's own version before dumping, so the registry can pick a matching tool. Defaults to MYSQL_CLI_PATH — reuses the same `mysql` client binary the MariaDB connection tester already uses for its SELECT 1/VERSION() checks (MariaDB is wire-compatible for that). Without this, version-aware resolution is skipped entirely and defaultMariaDbDumpPath is always used. */
  mysqlPath?: string;
  /** See mariaDbToolRegistry.ts. Omit to always use defaultMariaDbDumpPath, unchanged from this client's original single-path behavior. */
  registry?: MariaDbToolRegistry;
}

function baseArgs(config: DatabaseConnectionConfig): string[] {
  const args = ['--host', config.host, '--port', String(config.port), '--user', config.username];
  if (config.sslMode) args.push(...SSL_ARGS[config.sslMode]);
  return args;
}

/** Best-effort — a failure here just means falling back to the default path, never blocks the dump itself. */
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
 * Shells out to a local `mariadb-dump` (dev-time path via MARIADB_DUMP_PATH
 * env var — same pattern as PG_DUMP_PATH/MYSQLDUMP_PATH). Deliberately not
 * `mysqldump`, even though MariaDB ships both and they're wire-compatible
 * for connecting: `mariadb-dump` is the tool actually built and versioned
 * against this server, and its CLI surface already diverges from
 * mysqldump's in real, user-facing ways (see SSL_ARGS above) — treating it
 * as "just mysqldump under another name" is exactly the assumption the user
 * flagged as unsafe when this was first reviewed (see CLAUDE.md's
 * "direct_dump tool version management" note). `mariadb-dump` is GPLv2, same
 * licensing situation as `mysqldump` — the installer-bundling decision is
 * deferred to packaging for both, same as already noted for mysqldump.
 *
 * If both `registry` and `mysqlPath` are given, resolves which mariadb-dump
 * to actually run based on the target server's own detected major.minor
 * version (see mariaDbToolRegistry.ts) — falling back to
 * `defaultMariaDbDumpPath` (i.e. MARIADB_DUMP_PATH) whenever no matching
 * entry is registered, the version can't be detected, or no
 * registry/mysqlPath was supplied at all. Calling this with no arguments
 * behaves identically to before this existed: always the one configured
 * MARIADB_DUMP_PATH, no version query ever attempted.
 *
 * The password is passed via the MYSQL_PWD environment variable (still the
 * correct variable name for MariaDB's client tools, which inherit it from
 * MySQL), never as a CLI argument, for the same reason as pg_dump's
 * PGPASSWORD.
 */
export function createMariaDbDumpClient(deps: MariaDbDumpClientDeps = {}): DatabaseDumpClient {
  const defaultMariaDbDumpPath = deps.defaultMariaDbDumpPath ?? process.env.MARIADB_DUMP_PATH;
  const mysqlPath = deps.mysqlPath ?? process.env.MYSQL_CLI_PATH;
  const registry = deps.registry;

  return {
    engine: 'mariadb',
    async dump(config: DatabaseConnectionConfig, localTempPath: string): Promise<{ sizeBytes: number }> {
      const env: NodeJS.ProcessEnv = { ...process.env };
      if (config.password) env.MYSQL_PWD = config.password;

      let mariadbDumpPath = defaultMariaDbDumpPath;
      if (registry && mysqlPath) {
        const serverVersion = await detectServerVersion(mysqlPath, config, env);
        const resolved = serverVersion ? registry.resolve(serverVersion) : null;
        if (resolved) mariadbDumpPath = resolved.mariaDbDumpPath;
      }

      if (!mariadbDumpPath) {
        throw new Error('MARIADB_DUMP_PATH is not configured — cannot run mariadb-dump.');
      }

      const args = [...baseArgs(config), `--result-file=${localTempPath}`, config.databaseName];

      try {
        await execFileAsync(mariadbDumpPath, args, { env });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`mariadb-dump failed: ${message}`);
      }

      const fileStat = await stat(localTempPath);
      return { sizeBytes: fileStat.size };
    },
  };
}
