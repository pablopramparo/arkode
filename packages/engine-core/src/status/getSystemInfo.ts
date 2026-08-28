import { existsSync } from 'node:fs';
import { appDataDir, dbFilePath, logsDir } from '../paths.js';
import { resolveBundledToolPath, resolveToolPath } from '../toolPaths.js';

export interface ToolPathStatus {
  envVar: string;
  label: string;
  /** The effective path actually used: the env var if set, else a vendored copy next to engine-cli.exe, else null. */
  path: string | null;
  /** true only if `path` is set AND a file actually exists there. */
  exists: boolean;
  /** Where `path` came from — 'env' (the env var), 'bundled' (vendored next to engine-cli.exe), 'bundled-fallback' (a different-flavor bundled tool covering this slot, e.g. mariadb-dump standing in for mysqldump), or null (nothing resolved). */
  source: 'env' | 'bundled' | 'bundled-fallback' | null;
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
  {
    envVar: 'MYSQLDUMP_PATH',
    toolExe: 'mysqldump.exe',
    fallbackExe: 'mariadb-dump.exe',
    label: 'mysqldump (MySQL — generar dump; usa mariadb-dump incluido si no hay uno propio)',
  },
  { envVar: 'MARIADB_DUMP_PATH', toolExe: 'mariadb-dump.exe', label: 'mariadb-dump (MySQL/MariaDB — generar dump)' },
  {
    envVar: 'MYSQL_CLI_PATH',
    toolExe: 'mysql.exe',
    fallbackExe: 'mariadb.exe',
    label: 'mysql (MySQL/MariaDB — probar conexión; usa el cliente MariaDB incluido si no hay uno propio)',
  },
] as const;

/**
 * Read-only diagnostic snapshot for the UI's Configuración screen — resolves
 * where the app's own data lives and whether each tool path resolves (an
 * explicit env var, a vendored copy next to engine-cli.exe, or a
 * bundled-fallback of the other flavor). Doesn't change anything.
 */
export function getSystemInfo(): SystemInfo {
  return {
    appDataDir: appDataDir(),
    dbFilePath: dbFilePath(),
    logsDir: logsDir(),
    tools: TOOL_ENV_VARS.map((entry) => {
      const { envVar, toolExe, label } = entry;
      const fallbackExe = 'fallbackExe' in entry ? entry.fallbackExe : undefined;
      const fromEnv = process.env[envVar];
      const hasEnv = fromEnv != null && fromEnv.trim() !== '';
      const direct = resolveToolPath(envVar, toolExe);
      const fallback = direct ? undefined : fallbackExe ? resolveBundledToolPath(fallbackExe) : undefined;
      const path = direct ?? fallback ?? null;
      const source: ToolPathStatus['source'] =
        path == null ? null : hasEnv ? 'env' : direct ? 'bundled' : 'bundled-fallback';
      return { envVar, label, path, exists: path != null && existsSync(path), source };
    }),
  };
}
