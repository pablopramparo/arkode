import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat } from 'node:fs/promises';
import type { DatabaseDumpClient, DatabaseConnectionConfig } from './types.js';

const execFileAsync = promisify(execFile);

const SSL_MODE_FLAG: Record<NonNullable<DatabaseConnectionConfig['sslMode']>, string> = {
  disable: 'DISABLED',
  require: 'REQUIRED',
  'verify-full': 'VERIFY_IDENTITY',
};

/**
 * Shells out to a local `mysqldump` (dev-time path via MYSQLDUMP_PATH env
 * var — same pattern as pg_dump/pg_restore). mysqldump's client tools are
 * GPLv2, unlike PostgreSQL's permissive license; per the agreed increment
 * this is implemented dev-time-only, with the installer-bundling/licensing
 * decision deferred to packaging.
 *
 * The password is passed via the MYSQL_PWD environment variable, never as a
 * CLI argument, for the same reason as pg_dump's PGPASSWORD.
 */
export function createMysqlDumpClient(
  mysqldumpPath: string | undefined = process.env.MYSQLDUMP_PATH
): DatabaseDumpClient {
  return {
    engine: 'mysql',
    async dump(config: DatabaseConnectionConfig, localTempPath: string): Promise<{ sizeBytes: number }> {
      if (!mysqldumpPath) {
        throw new Error('MYSQLDUMP_PATH is not configured — cannot run mysqldump.');
      }

      const args = ['--host', config.host, '--port', String(config.port), '--user', config.username];
      if (config.sslMode) {
        args.push(`--ssl-mode=${SSL_MODE_FLAG[config.sslMode]}`);
      }
      args.push(`--result-file=${localTempPath}`, config.databaseName);

      const env: NodeJS.ProcessEnv = { ...process.env };
      if (config.password) env.MYSQL_PWD = config.password;

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
