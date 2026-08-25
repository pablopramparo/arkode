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
  /** The source machine's own path — kept for reference, but never reused directly on import (see privateKeyContentBase64). */
  privateKeyPath: string;
  /** The private key file's own content, base64-encoded, so import can write a working copy on the target machine — null if the file couldn't be read at export time (moved, permissions, etc.), in which case the import falls back to today's path-only behavior and flags it in secretsNeedingReentry. */
  privateKeyContentBase64: string | null;
  hasPassphrase: boolean;
  remotePath: string | null;
  remoteFilePattern: string | null;
  remoteCommand: string | null;
  remoteOutputPathTemplate: string | null;
  remoteCleanup: boolean;
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
