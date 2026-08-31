import { existsSync } from 'node:fs';
import type { DatabaseConnection } from '../types.js';
import type { SecretStore } from '../secrets/types.js';
import type { SettingsRepo } from '../db/repositories/settingsRepo.js';
import type { ConnectionTestResult } from '../transports/types.js';
import { testDatabaseConnection } from './testDatabaseConnection.js';
import { createPostgresToolRegistry } from './postgresToolRegistry.js';
import { createMysqlToolRegistry } from './mysqlToolRegistry.js';
import { createMariaDbToolRegistry } from './mariaDbToolRegistry.js';
import { resolveToolPath } from '../toolPaths.js';
import { resolveMariaDbFamilyDump } from './mysqlClientResolution.js';

/**
 * - 'registered'         — an exact-version match was found in the engine's
 *                          own tool registry (postgresToolRegistry.ts /
 *                          mysqlToolRegistry.ts / mariaDbToolRegistry.ts).
 * - 'default-unverified' — no version-specific match, but the engine's default
 *                          env-var tool path (PG_DUMP_PATH / MYSQLDUMP_PATH /
 *                          MARIADB_DUMP_PATH) is configured and the file exists
 *                          on disk — usable, but never confirmed compatible
 *                          with this specific server version.
 * - 'missing'            — no usable tool path resolved at all, or the
 *                          resolved path doesn't exist on disk.
 */
export type ToolCompatibility = 'registered' | 'default-unverified' | 'missing';

export interface DirectDumpCompatibilityResult {
  /** Overall gate verdict: false if the connection itself failed, or no usable local dump tool exists on disk. */
  ok: boolean;
  connection: ConnectionTestResult;
  toolPath?: string;
  toolCompatibility: ToolCompatibility;
  message: string;
}

export interface TestDirectDumpCompatibilityDeps {
  /**
   * Test-only seam overriding the connectivity+version check, so unit tests
   * can exercise the tool-resolution branches below without a real DB
   * server — mirrors RunBackupTaskDeps.resolveExecutorOverride's role for
   * the orchestrator. Production code never sets this.
   */
  testConnectionOverride?: typeof testDatabaseConnection;
}

const DEFAULT_TOOL_ENV_VAR: Record<DatabaseConnection['engine'], string> = {
  postgres: 'PG_DUMP_PATH',
  mysql: 'MYSQLDUMP_PATH',
  mariadb: 'MARIADB_DUMP_PATH',
};

/**
 * The exact fallback dump-tool resolution the real dump clients use when no
 * version-keyed registry entry matches — the env var first, then the tool
 * vendored next to engine-cli.exe (resolveToolPath). MUST stay in sync with
 * postgresDumpClient.ts / mysqlDumpClient.ts / mariaDbDumpClient.ts, so this
 * schedule-activation gate never refuses a task that "Ejecutar ahora" would
 * run fine. For a `mysql` connection this deliberately includes the bundled
 * `mariadb-dump` (arkode ships MariaDB's tools, not Oracle's) — that's what
 * a zero-config MySQL direct_dump actually runs.
 */
function resolveDefaultDumpToolPath(engine: DatabaseConnection['engine']): string | undefined {
  switch (engine) {
    case 'postgres':
      return resolveToolPath('PG_DUMP_PATH', 'pg_dump.exe');
    case 'mysql':
      return resolveToolPath('MYSQLDUMP_PATH', 'mysqldump.exe') ?? resolveToolPath('MARIADB_DUMP_PATH', 'mariadb-dump.exe');
    case 'mariadb':
      return resolveMariaDbFamilyDump()?.path;
  }
}

/**
 * The pre-flight compatibility gate flagged in CLAUDE.md's "direct_dump tool
 * version management" note as item (4) — distinct from
 * testDatabaseConnection()/database-connection:test, which only proves
 * connectivity + auth. This additionally answers: is the server's version
 * actually known, and is there a local dump tool that's either a confirmed
 * version match (via the engine's own tool registry) or at least present on
 * disk as a fallback default? Meant to gate ever enabling a direct_dump
 * task's automatic schedule, not to block a manual "run now."
 */
export async function testDirectDumpCompatibility(
  connection: DatabaseConnection,
  secretStore: SecretStore,
  settingsRepo?: SettingsRepo,
  deps: TestDirectDumpCompatibilityDeps = {}
): Promise<DirectDumpCompatibilityResult> {
  const runConnectionTest = deps.testConnectionOverride ?? testDatabaseConnection;
  const connectionResult = await runConnectionTest(connection, secretStore);

  if (!connectionResult.ok) {
    return {
      ok: false,
      connection: connectionResult,
      toolCompatibility: 'missing',
      message: `Connection failed: ${connectionResult.message}`,
    };
  }

  let toolPath: string | undefined;
  let toolCompatibility: ToolCompatibility = 'missing';

  if (settingsRepo && connectionResult.serverVersion) {
    if (connection.engine === 'postgres') {
      const resolved = createPostgresToolRegistry(settingsRepo).resolve(connectionResult.serverVersion);
      if (resolved) {
        toolPath = resolved.pgDumpPath;
        toolCompatibility = 'registered';
      }
    } else if (connection.engine === 'mysql') {
      const resolved = createMysqlToolRegistry(settingsRepo).resolve(connectionResult.serverVersion);
      if (resolved) {
        toolPath = resolved.mysqldumpPath;
        toolCompatibility = 'registered';
      }
    } else {
      const resolved = createMariaDbToolRegistry(settingsRepo).resolve(connectionResult.serverVersion);
      if (resolved) {
        toolPath = resolved.mariaDbDumpPath;
        toolCompatibility = 'registered';
      }
    }
  }

  if (!toolPath) {
    const defaultPath = resolveDefaultDumpToolPath(connection.engine);
    if (defaultPath) {
      toolPath = defaultPath;
      toolCompatibility = 'default-unverified';
    }
  }

  if (!toolPath || !existsSync(toolPath)) {
    return {
      ok: false,
      connection: connectionResult,
      toolCompatibility: 'missing',
      message: `No usable dump tool for ${connection.engine} was found on disk (checked ${DEFAULT_TOOL_ENV_VAR[connection.engine]}, the tool registry, and the bundled tools).`,
    };
  }

  const message =
    toolCompatibility === 'registered'
      ? `Compatible tool confirmed for detected server version ${connectionResult.serverVersion}.`
      : `Using the default configured tool — not confirmed compatible with detected server version ${connectionResult.serverVersion ?? '(unknown)'}.`;

  return { ok: true, connection: connectionResult, toolPath, toolCompatibility, message };
}
