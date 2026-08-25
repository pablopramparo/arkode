import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat } from 'node:fs/promises';
import type { DatabaseDumpClient, DatabaseConnectionConfig } from './types.js';
import type { PostgresToolRegistry } from './postgresToolRegistry.js';

const execFileAsync = promisify(execFile);

export interface PostgresDumpClientDeps {
  /** Fallback pg_dump path, used whenever the registry has no match (or isn't provided at all). Defaults to PG_DUMP_PATH. */
  defaultPgDumpPath?: string;
  /** Needed to query the server's own version before dumping, so the registry can pick a matching tool. Defaults to PSQL_PATH. Without this, version-aware resolution is skipped entirely and defaultPgDumpPath is always used. */
  psqlPath?: string;
  /** See postgresToolRegistry.ts. Omit to always use defaultPgDumpPath, unchanged from this client's original single-path behavior. */
  registry?: PostgresToolRegistry;
}

/** Best-effort — a failure here (missing psqlPath, connection error, whatever) just means falling back to the default path, never blocks the dump itself. */
async function detectServerVersion(psqlPath: string, config: DatabaseConnectionConfig): Promise<string | undefined> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (config.password) env.PGPASSWORD = config.password;
  if (config.sslMode) env.PGSSLMODE = config.sslMode;
  try {
    const { stdout } = await execFileAsync(
      psqlPath,
      [
        '--host',
        config.host,
        '--port',
        String(config.port),
        '--username',
        config.username,
        '--dbname',
        config.databaseName,
        '--no-password',
        '--tuples-only',
        '--no-align',
        '--command',
        'SHOW server_version',
      ],
      { env }
    );
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Shells out to a local `pg_dump` (dev-time path via PG_DUMP_PATH env var —
 * proper installer-vendoring is a later packaging concern, same as
 * postgresCustomValidator's PG_RESTORE_PATH). Always produces a custom-format
 * dump (`--format custom`) so the result can be validated the same way as
 * fetch_existing/remote_dump dumps, via `pg_restore --list`.
 *
 * If both `registry` and `psqlPath` are given, resolves which pg_dump to
 * actually run based on the target server's own detected major version
 * (see postgresToolRegistry.ts) — falling back to `defaultPgDumpPath` (i.e.
 * PG_DUMP_PATH) whenever no matching entry is registered, the version can't
 * be detected, or no registry/psqlPath was supplied at all. Calling this
 * with no arguments (as `directDumpExecutor.ts` does when no registry has
 * been set up) behaves identically to before this existed: always the one
 * configured PG_DUMP_PATH, no version query ever attempted.
 *
 * The password is passed via the PGPASSWORD environment variable, never as a
 * CLI argument — argv is visible to other processes/Task Manager, env vars
 * of a child process are not.
 */
export function createPostgresDumpClient(deps: PostgresDumpClientDeps = {}): DatabaseDumpClient {
  const defaultPgDumpPath = deps.defaultPgDumpPath ?? process.env.PG_DUMP_PATH;
  const psqlPath = deps.psqlPath ?? process.env.PSQL_PATH;
  const registry = deps.registry;

  return {
    engine: 'postgres',
    async dump(config: DatabaseConnectionConfig, localTempPath: string): Promise<{ sizeBytes: number }> {
      let pgDumpPath = defaultPgDumpPath;
      if (registry && psqlPath) {
        const serverVersion = await detectServerVersion(psqlPath, config);
        const resolved = serverVersion ? registry.resolve(serverVersion) : null;
        if (resolved) pgDumpPath = resolved.pgDumpPath;
      }

      if (!pgDumpPath) {
        throw new Error('PG_DUMP_PATH is not configured — cannot run pg_dump.');
      }

      const args = [
        '--host',
        config.host,
        '--port',
        String(config.port),
        '--username',
        config.username,
        '--format',
        'custom',
        '--file',
        localTempPath,
        '--no-password',
        config.databaseName,
      ];

      const env: NodeJS.ProcessEnv = { ...process.env };
      if (config.password) env.PGPASSWORD = config.password;
      if (config.sslMode) env.PGSSLMODE = config.sslMode;

      try {
        await execFileAsync(pgDumpPath, args, { env });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`pg_dump failed: ${message}`);
      }

      const fileStat = await stat(localTempPath);
      return { sizeBytes: fileStat.size };
    },
  };
}
