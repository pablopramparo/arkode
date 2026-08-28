import { existsSync } from 'node:fs';
import { appDataDir, dbFilePath, logsDir } from '../paths.js';
import { resolveToolPath } from '../toolPaths.js';

export interface ToolPathStatus {
  envVar: string;
  label: string;
  /** The effective path actually used: the env var if set, else a vendored copy next to engine-cli.exe, else null. */
  path: string | null;
  /** true only if `path` is set AND a file actually exists there. */
  exists: boolean;
  /** Where `path` came from — 'env' (the env var), 'bundled' (vendored next to engine-cli.exe), or null (nothing resolved). */
  source: 'env' | 'bundled' | null;
}

export interface SystemInfo {
  appDataDir: string;
  dbFilePath: string;
  logsDir: string;
  tools: ToolPathStatus[];
}

const TOOL_ENV_VARS = [
  { envVar: 'PG_DUMP_PATH', toolExe: 'pg_dump.exe', label: 'pg_dump (Postgres — generar dump)' },
  { envVar: 'PG_RESTORE_PATH', toolExe: 'pg_restore.exe', label: 'pg_restore (Postgres — validar dump)' },
  { envVar: 'PSQL_PATH', toolExe: 'psql.exe', label: 'psql (Postgres — probar conexión)' },
  { envVar: 'MYSQLDUMP_PATH', toolExe: 'mysqldump.exe', label: 'mysqldump (MySQL — generar dump)' },
  { envVar: 'MARIADB_DUMP_PATH', toolExe: 'mariadb-dump.exe', label: 'mariadb-dump (MariaDB — generar dump)' },
  { envVar: 'MYSQL_CLI_PATH', toolExe: 'mysql.exe', label: 'mysql (MySQL/MariaDB — probar conexión)' },
] as const;

/**
 * Read-only diagnostic snapshot for the UI's Configuración screen — resolves
 * where the app's own data lives and whether each dev-time tool-path env var
 * is set and actually points at a file that exists. Doesn't change anything.
 */
export function getSystemInfo(): SystemInfo {
  return {
    appDataDir: appDataDir(),
    dbFilePath: dbFilePath(),
    logsDir: logsDir(),
    tools: TOOL_ENV_VARS.map(({ envVar, toolExe, label }) => {
      const fromEnv = process.env[envVar];
      const hasEnv = fromEnv != null && fromEnv.trim() !== '';
      const path = resolveToolPath(envVar, toolExe) ?? null;
      const source = path == null ? null : hasEnv ? 'env' : 'bundled';
      return { envVar, label, path, exists: path != null && existsSync(path), source };
    }),
  };
}
