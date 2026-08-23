import { join } from 'node:path';

const APP_DIR_NAME = 'CodebiusBackupManager';

/**
 * All config/history/logs live under AppData, never inside the install
 * folder, so an app update never touches them. CODEBIUS_APP_DATA_DIR lets
 * tests/dev point this at a throwaway directory instead.
 */
export function appDataDir(): string {
  const override = process.env.CODEBIUS_APP_DATA_DIR;
  if (override) return override;

  const appData = process.env.APPDATA;
  if (!appData) {
    throw new Error('APPDATA environment variable is not set; cannot resolve app data directory.');
  }
  return join(appData, APP_DIR_NAME);
}

export function dbFilePath(): string {
  return join(appDataDir(), 'data.sqlite3');
}

export function logsDir(): string {
  return join(appDataDir(), 'logs');
}

export function migrationsSourceDir(): string {
  return join(import.meta.dirname, 'db', 'migrations');
}

/**
 * Suggested default root for a new client's local_base_path. Backups can be
 * large, so this defaults to LOCALAPPDATA (not roamed) rather than APPDATA —
 * purely a UI suggestion; each client's local_base_path is stored explicitly
 * and can point anywhere (e.g. a separate data drive).
 */
export function defaultBackupsRootDir(): string {
  const override = process.env.CODEBIUS_APP_DATA_DIR;
  if (override) return join(override, 'Backups');

  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    throw new Error('LOCALAPPDATA environment variable is not set; cannot resolve default backups directory.');
  }
  return join(localAppData, APP_DIR_NAME, 'Backups');
}
