import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ConnectionTestResult } from '../transports/types.js';
import type { DatabaseConnectionConfig } from './types.js';

const execFileAsync = promisify(execFile);

/** Best-effort — a failure here never fails the overall test, since the connectivity check already succeeded by the time this runs. */
async function getServerVersion(
  mysqlPath: string,
  baseArgs: string[],
  env: NodeJS.ProcessEnv,
  databaseName: string
): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      mysqlPath,
      [...baseArgs, '--batch', '--skip-column-names', '--execute=SELECT VERSION()', databaseName],
      { env }
    );
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function getLocalToolVersion(mysqlPath: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(mysqlPath, ['--version']);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Tests connectivity + authentication without producing a dump: runs a
 * trivial query via the `mysql` CLI client, bundled alongside `mysqldump` in
 * the same MySQL bin directory. Dev-time path via MYSQL_CLI_PATH env var
 * (named distinctly from MYSQLDUMP_PATH — they're two different binaries).
 *
 * Also reports the server's and the local mysql client's own version
 * (best-effort, never fails the test if either lookup itself fails) — see
 * ConnectionTestResult.serverVersion/localToolVersion and the "direct_dump
 * tool version management" note in CLAUDE.md. `SELECT VERSION()` doubles as
 * the MySQL/MariaDB distinguisher, since MariaDB's version string includes
 * "MariaDB" (e.g. "10.11.6-MariaDB") while MySQL's doesn't. This is version
 * *visibility*, not a compatibility gate — nothing here blocks a task from
 * running based on a version mismatch.
 */
export function createMysqlConnectionTester(mysqlPath: string | undefined = process.env.MYSQL_CLI_PATH) {
  return async function testMysqlConnection(config: DatabaseConnectionConfig): Promise<ConnectionTestResult> {
    if (!mysqlPath) {
      return { ok: false, message: 'MYSQL_CLI_PATH is not configured — cannot test the connection.' };
    }

    const baseArgs = ['--host', config.host, '--port', String(config.port), '--user', config.username];
    if (config.sslMode === 'disable') baseArgs.push('--ssl-mode=DISABLED');
    else if (config.sslMode === 'require') baseArgs.push('--ssl-mode=REQUIRED');
    else if (config.sslMode === 'verify-full') baseArgs.push('--ssl-mode=VERIFY_IDENTITY');

    const env: NodeJS.ProcessEnv = { ...process.env };
    if (config.password) env.MYSQL_PWD = config.password;

    const startedAt = Date.now();
    try {
      await execFileAsync(mysqlPath, [...baseArgs, '--execute=SELECT 1', config.databaseName], { env });
      const latencyMs = Date.now() - startedAt;
      const [serverVersion, localToolVersion] = await Promise.all([
        getServerVersion(mysqlPath, baseArgs, env, config.databaseName),
        getLocalToolVersion(mysqlPath),
      ]);
      return { ok: true, message: 'Connection succeeded.', latencyMs, serverVersion, localToolVersion };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  };
}
