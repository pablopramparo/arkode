export type BackupStrategyKind = 'fetch_existing' | 'remote_dump' | 'direct_dump';
export type TransportType = 'sftp' | 'ssh' | 'ftp';
export type DbEngine = 'postgres' | 'mysql' | 'mariadb' | 'unknown';
export type ScheduleFrequency = 'daily' | 'weekly' | 'monthly';
/**
 * 'mariadb' is declared but not implemented — MySQL and MariaDB are
 * wire-compatible but not interchangeable at the dump-tool level
 * (mysqldump vs mariadb-dump, version compatibility rules differ). Widened
 * now (cheap, nothing has shipped yet) rather than later, when adding a
 * value to a SQLite CHECK constraint needs a real table-recreate migration.
 * See databaseConnections/mariaDbDumpClient.ts and CLAUDE.md's "direct_dump
 * tool version management" note for the real implementation this unblocks.
 */
export type DatabaseEngine = 'postgres' | 'mysql' | 'mariadb';

export type BackupRunStatus =
  | 'Pending'
  | 'Running'
  | 'Producing'
  | 'Validating'
  | 'Success'
  | 'Warning'
  | 'Failed';

export interface Client {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  localBasePath: string;
  retentionCount: number | null;
  retentionDays: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface Transport {
  id: string;
  clientId: string;
  name: string;
  type: TransportType;
  host: string;
  port: number;
  username: string;
  /** sftp/ssh only — null for ftp, which authenticates with passwordSecretRef instead. */
  privateKeyPath: string | null;
  passphraseSecretRef: string | null;
  /** ftp only. */
  passwordSecretRef: string | null;
  knownHostFingerprint: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DatabaseConnection {
  id: string;
  clientId: string;
  name: string;
  engine: DatabaseEngine;
  host: string;
  port: number;
  databaseName: string;
  username: string;
  passwordSecretRef: string | null;
  sslMode: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BackupTask {
  id: string;
  clientId: string;
  strategy: BackupStrategyKind;
  transportId: string | null;
  databaseConnectionId: string | null;
  name: string;
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
  /** 0 (Sunday) through 6 (Saturday). Only meaningful when scheduleFrequency is 'weekly'. */
  scheduleDaysOfWeek: number[] | null;
  /** 1-31. Only meaningful when scheduleFrequency is 'monthly'. */
  scheduleDayOfMonth: number | null;
  retentionCount: number | null;
  retentionDays: number | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BackupRun {
  id: string;
  taskId: string;
  clientId: string;
  strategy: BackupStrategyKind;
  transportId: string | null;
  databaseConnectionId: string | null;
  status: BackupRunStatus;
  remoteFileName: string | null;
  remotePath: string | null;
  remoteModifiedAt: string | null;
  startedAt: string;
  finishedAt: string | null;
  downloadedAt: string | null;
  localPath: string | null;
  sizeBytes: number | null;
  checksumSha256: string | null;
  durationMs: number | null;
  errorMessage: string | null;
  errorStack: string | null;
  logFilePath: string | null;
  pid: number | null;
  createdAt: string;
}

export interface RetentionDeletion {
  id: string;
  taskId: string;
  deletedBackupRunId: string;
  triggeredByRunId: string | null;
  localPath: string;
  sizeBytes: number | null;
  reason: string;
  deletedAt: string;
}

export interface KnownHost {
  id: string;
  host: string;
  port: number;
  keyType: string;
  fingerprintSha256: string;
  firstSeenAt: string;
  confirmedAt: string | null;
}
