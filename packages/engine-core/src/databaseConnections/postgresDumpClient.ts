import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat } from 'node:fs/promises';
import type { DatabaseDumpClient, DatabaseConnectionConfig } from './types.js';

const execFileAsync = promisify(execFile);

/**
 * Shells out to a local `pg_dump` (dev-time path via PG_DUMP_PATH env var —
 * proper installer-vendoring is a later packaging concern, same as
 * postgresCustomValidator's PG_RESTORE_PATH). Always produces a custom-format
 * dump (`--format custom`) so the result can be validated the same way as
 * fetch_existing/remote_dump dumps, via `pg_restore --list`.
 *
 * The password is passed via the PGPASSWORD environment variable, never as a
 * CLI argument — argv is visible to other processes/Task Manager, env vars
 * of a child process are not.
 */
export function createPostgresDumpClient(pgDumpPath: string | undefined = process.env.PG_DUMP_PATH): DatabaseDumpClient {
  return {
    engine: 'postgres',
    async dump(config: DatabaseConnectionConfig, localTempPath: string): Promise<{ sizeBytes: number }> {
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
