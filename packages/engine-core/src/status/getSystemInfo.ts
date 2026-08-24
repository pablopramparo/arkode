import { existsSync } from 'node:fs';
import { appDataDir, dbFilePath, logsDir } from '../paths.js';

export interface ToolPathStatus {
  envVar: string;
  label: string;
  path: string | null;
  /** true only if `path` is set AND a file actually exists there. */
  exists: boolean;
}

export interface SystemInfo {
  appDataDir: string;
  dbFilePath: string;
  logsDir: string;
  tools: ToolPathStatus[];
}

const TOOL_ENV_VARS = [
  { envVar: 'PG_DUMP_PATH', label: 'pg_dump (Postgres — generar dump)' },
  { envVar: 'PG_RESTORE_PATH', label: 'pg_restore (Postgres — validar dump)' },
  { envVar: 'PSQL_PATH', label: 'psql (Postgres — probar conexión)' },
  { envVar: 'MYSQLDUMP_PATH', label: 'mysqldump (MySQL/MariaDB — generar dump)' },
  { envVar: 'MYSQL_CLI_PATH', label: 'mysql (MySQL/MariaDB — probar conexión)' },
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
    tools: TOOL_ENV_VARS.map(({ envVar, label }) => {
      const path = process.env[envVar] ?? null;
      return { envVar, label, path, exists: path != null && existsSync(path) };
    }),
  };
}
