import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ConnectionTestResult } from '../transports/types.js';
import type { DatabaseConnectionConfig } from './types.js';
import { mysqlFamilySslArgs, resolveMysqlFamilyCli } from './mysqlClientResolution.js';

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
 *
 * With no explicit path and no MYSQL_CLI_PATH, this resolves the bundled
 * MariaDB client (see mysqlClientResolution.ts) — so a MySQL/MariaDB
 * connection test works out of the box on a real install. SSL flags are
 * emitted in the syntax the resolved binary's flavor actually accepts
 * (`mariadb` has no `--ssl-mode=X`).
 */
export function createMysqlConnectionTester(mysqlPath?: string) {
  const resolved = resolveMysqlFamilyCli(mysqlPath);
  return async function testMysqlConnection(config: DatabaseConnectionConfig): Promise<ConnectionTestResult> {
    if (!resolved) {
      return {
        ok: false,
        message: 'No hay un cliente mysql/mariadb disponible — configurá MYSQL_CLI_PATH o reinstalá arkode (trae el cliente de MariaDB incluido).',
      };
    }
    const { path: clientPath, flavor, extraArgs } = resolved;

    const baseArgs = [
      ...extraArgs,
      '--host',
      config.host,
      '--port',
      String(config.port),
      '--user',
      config.username,
      ...mysqlFamilySslArgs(flavor, config.sslMode),
    ];

    const env: NodeJS.ProcessEnv = { ...process.env };
    if (config.password) env.MYSQL_PWD = config.password;

    const startedAt = Date.now();
    try {
      await execFileAsync(clientPath, [...baseArgs, '--execute=SELECT 1', config.databaseName], { env });
      const latencyMs = Date.now() - startedAt;
      const [serverVersion, localToolVersion] = await Promise.all([
        getServerVersion(clientPath, baseArgs, env, config.databaseName),
        getLocalToolVersion(clientPath),
      ]);
      return { ok: true, message: 'Connection succeeded.', latencyMs, serverVersion, localToolVersion };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  };
}
