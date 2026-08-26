import type { BackupStrategyKind, DatabaseEngine, DbEngine, ScheduleFrequency, TransportType } from '../types.js';

/**
 * A portable configuration snapshot for one or more clients — never
 * includes secrets (SSH key passphrases, DB passwords). Those live only in
 * Windows Credential Manager on the machine that created them; exporting a
 * secret_ref would be meaningless on another machine and a real risk on the
 * same one. `hasPassphrase`/`hasPassword` tell the importer which
 * transports/database connections will need a secret re-entered after
 * import — see importConfig.ts's ImportResult.
 */
export interface ConfigExport {
  schemaVersion: 1;
  exportedAt: string;
  clients: ExportedClient[];
}

export interface ExportedTransport {
  name: string;
  type: TransportType;
  host: string;
  port: number;
  username: string;
  /** sftp/ssh only — null for ftp, which has no key at all. The source machine's own path — kept for reference, but never reused directly on import (see privateKeyContentBase64). */
  privateKeyPath: string | null;
  /** The private key file's own content, base64-encoded, so import can write a working copy on the target machine — null if the file couldn't be read at export time (moved, permissions, etc.), in which case the import falls back to today's path-only behavior and flags it in secretsNeedingReentry. Always null for ftp. */
  privateKeyContentBase64: string | null;
  hasPassphrase: boolean;
  /** ftp only. */
  hasPassword: boolean;
  knownHostFingerprint: string | null;
}

export interface ExportedDatabaseConnection {
  name: string;
  engine: DatabaseEngine;
  host: string;
  port: number;
  databaseName: string;
  username: string;
  hasPassword: boolean;
  sslMode: string | null;
}

export interface ExportedTask {
  name: string;
  strategy: BackupStrategyKind;
  /** Resolved by name against this same client's transports/databaseConnections on import — raw ids never survive export. */
  transportName: string | null;
  databaseConnectionName: string | null;
  dbEngine: DbEngine;
  /** fetch_existing only. */
  remotePath: string | null;
  remoteFilePattern: string | null;
  /** remote_dump only. */
  remoteCommand: string | null;
  remoteOutputPathTemplate: string | null;
  remoteCleanup: boolean;
  scheduleTime: string | null;
  scheduleEnabled: boolean;
  scheduleFrequency: ScheduleFrequency;
  scheduleDaysOfWeek: number[] | null;
  scheduleDayOfMonth: number | null;
  retentionCount: number | null;
  retentionDays: number | null;
}

export interface ExportedClient {
  name: string;
  description: string | null;
  localBasePath: string;
  retentionCount: number | null;
  retentionDays: number | null;
  transports: ExportedTransport[];
  databaseConnections: ExportedDatabaseConnection[];
  tasks: ExportedTask[];
}

/**
 * A single task plus the one transport or database connection it depends
 * on — portable independently of a whole client, unlike ConfigExport
 * (which always carries a complete client). Meant to be attached to an
 * *existing* client on import (see importConfig.ts's importTaskBundle),
 * not to recreate a client the way ConfigExport's import does.
 */
export interface ExportedTaskBundle {
  schemaVersion: 1;
  exportedAt: string;
  task: ExportedTask;
  transport: ExportedTransport | null;
  databaseConnection: ExportedDatabaseConnection | null;
}
