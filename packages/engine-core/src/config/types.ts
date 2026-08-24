import type { BackupStrategyKind, DatabaseEngine, DbEngine, TransportType } from '../types.js';

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
  privateKeyPath: string;
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
