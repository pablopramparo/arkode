import { join } from 'node:path';

const APP_DIR_NAME = 'CodebiusBackupManager';

/**
 * All config/history/logs live under ProgramData, never inside the install
 * folder, so an app update never touches them. CODEBIUS_APP_DATA_DIR lets
 * tests/dev point this at a throwaway directory instead.
 *
 * Deliberately ProgramData, not APPDATA: APPDATA is per-user (a different,
 * empty path for every Windows account), which silently broke the
 * scheduler the moment its Scheduled Task started running as SYSTEM
 * instead of the interactive user (see taskDefinitionXml.ts) — SYSTEM has
 * its own APPDATA, pointing at nothing this app ever wrote. ProgramData is
 * the Windows-documented location for exactly this: data shared by every
 * account on the machine, independent of who's actually running the
 * process. Same reasoning that motivated the secrets table's move to
 * LocalMachine-scope DPAPI, applied to where the data itself lives.
 */
export function appDataDir(): string {
  const override = process.env.CODEBIUS_APP_DATA_DIR;
  if (override) return override;

  const programData = process.env.PROGRAMDATA;
  if (!programData) {
    throw new Error('PROGRAMDATA environment variable is not set; cannot resolve app data directory.');
  }
  return join(programData, APP_DIR_NAME);
}

export function dbFilePath(): string {
  return join(appDataDir(), 'data.sqlite3');
}

export function logsDir(): string {
  return join(appDataDir(), 'logs');
}

/**
 * Where this app keeps its own copies of SSH private key files — both ones
 * restored from a portable config export (config/importConfig.ts) and ones
 * copied in at transport-creation time (transports/copyPrivateKey.ts).
 * Owning a copy here, rather than referencing wherever the user originally
 * put the file, means a SYSTEM-run scheduled task never has to worry about
 * that original location's permissions or the file being moved/deleted
 * later — same reasoning as ProgramData for appDataDir() above.
 */
export function keysDir(): string {
  return join(appDataDir(), 'keys');
}

export function migrationsSourceDir(): string {
  return join(import.meta.dirname, 'db', 'migrations');
}

/**
 * Suggested default root for a new client's local_base_path — purely a UI
 * suggestion; each client's local_base_path is stored explicitly and can
 * point anywhere (e.g. a separate data drive). Deliberately under
 * ProgramData, not a specific user's profile: a backup folder living
 * inside `C:\Users\SomeUser\...` is exactly the kind of path a SYSTEM-run
 * scheduled task (see taskDefinitionXml.ts) might not have write access
 * to, depending on that folder's ACLs — defaulting to a machine-wide
 * location sidesteps the question entirely rather than relying on every
 * installer remembering to avoid it.
 */
export function defaultBackupsRootDir(): string {
  const override = process.env.CODEBIUS_APP_DATA_DIR;
  if (override) return join(override, 'Backups');

  const programData = process.env.PROGRAMDATA;
  if (!programData) {
    throw new Error('PROGRAMDATA environment variable is not set; cannot resolve default backups directory.');
  }
  return join(programData, APP_DIR_NAME, 'Backups');
}
