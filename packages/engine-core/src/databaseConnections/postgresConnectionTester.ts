import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ConnectionTestResult } from '../transports/types.js';
import type { DatabaseConnectionConfig } from './types.js';

const execFileAsync = promisify(execFile);

/**
 * Tests connectivity + authentication without producing a dump: runs a
 * trivial query via `psql`, bundled alongside `pg_dump`/`pg_restore` in the
 * same PostgreSQL bin directory. Dev-time path via PSQL_PATH env var, same
 * pattern as PG_DUMP_PATH/PG_RESTORE_PATH.
 */
export function createPostgresConnectionTester(psqlPath: string | undefined = process.env.PSQL_PATH) {
  return async function testPostgresConnection(config: DatabaseConnectionConfig): Promise<ConnectionTestResult> {
    if (!psqlPath) {
      return { ok: false, message: 'PSQL_PATH is not configured — cannot test the connection.' };
    }

    const args = [
      '--host',
      config.host,
      '--port',
      String(config.port),
      '--username',
      config.username,
      '--dbname',
      config.databaseName,
      '--no-password',
      '--set=ON_ERROR_STOP=1',
      '--command',
      'SELECT 1',
    ];

    const env: NodeJS.ProcessEnv = { ...process.env };
    if (config.password) env.PGPASSWORD = config.password;
    if (config.sslMode) env.PGSSLMODE = config.sslMode;

    const startedAt = Date.now();
    try {
      await execFileAsync(psqlPath, args, { env });
      return { ok: true, message: 'Connection succeeded.', latencyMs: Date.now() - startedAt };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  };
}
