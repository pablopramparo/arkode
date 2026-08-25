import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ConnectionTestResult } from '../transports/types.js';
import type { DatabaseConnectionConfig } from './types.js';

const execFileAsync = promisify(execFile);

/** Best-effort — a failure here never fails the overall test, since the connectivity check already succeeded by the time this runs. */
async function getServerVersion(psqlPath: string, baseArgs: string[], env: NodeJS.ProcessEnv): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      psqlPath,
      [...baseArgs, '--tuples-only', '--no-align', '--command', 'SHOW server_version'],
      { env }
    );
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function getLocalToolVersion(psqlPath: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(psqlPath, ['--version']);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Tests connectivity + authentication without producing a dump: runs a
 * trivial query via `psql`, bundled alongside `pg_dump`/`pg_restore` in the
 * same PostgreSQL bin directory. Dev-time path via PSQL_PATH env var, same
 * pattern as PG_DUMP_PATH/PG_RESTORE_PATH.
 *
 * Also reports the server's and the local psql's own version (best-effort,
 * never fails the test if either lookup itself fails) — see
 * ConnectionTestResult.serverVersion/localToolVersion and the "direct_dump
 * tool version management" note in CLAUDE.md. This is version *visibility*,
 * not a compatibility gate — nothing here blocks a task from running based
 * on a version mismatch.
 */
export function createPostgresConnectionTester(psqlPath: string | undefined = process.env.PSQL_PATH) {
  return async function testPostgresConnection(config: DatabaseConnectionConfig): Promise<ConnectionTestResult> {
    if (!psqlPath) {
      return { ok: false, message: 'PSQL_PATH is not configured — cannot test the connection.' };
    }

    const baseArgs = [
      '--host',
      config.host,
      '--port',
      String(config.port),
      '--username',
      config.username,
      '--dbname',
      config.databaseName,
      '--no-password',
    ];

    const env: NodeJS.ProcessEnv = { ...process.env };
    if (config.password) env.PGPASSWORD = config.password;
    if (config.sslMode) env.PGSSLMODE = config.sslMode;

    const startedAt = Date.now();
    try {
      await execFileAsync(psqlPath, [...baseArgs, '--set=ON_ERROR_STOP=1', '--command', 'SELECT 1'], { env });
      const latencyMs = Date.now() - startedAt;
      const [serverVersion, localToolVersion] = await Promise.all([
        getServerVersion(psqlPath, baseArgs, env),
        getLocalToolVersion(psqlPath),
      ]);
      return { ok: true, message: 'Connection succeeded.', latencyMs, serverVersion, localToolVersion };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  };
}
