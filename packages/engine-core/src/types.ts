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

/**
 * A pure visual/reporting label grouping several existing tasks (DB-backup
 * and/or file-backup) under one name per client, e.g. "Sitio X" = its
 * database task + its uploads-folder task. Deliberately not a scheduling or
 * execution concept — see backup_sets' migration comment for the full
 * scope boundary.
 */
export interface BackupSet {
  id: string;
  clientId: string;
  name: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

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

/**
 * remote_dump only. 'host' (default): remoteCommand is a raw shell command
 * run directly on the SSH host, exactly as this strategy has always worked.
 * 'docker': the database runs inside a Docker container (e.g. Coolify) —
 * remoteCommand is unused, and arkode itself constructs the dump command
 * from dockerContainer/remoteDumpDatabase/remoteDumpDbUser/dbEngine via a
 * root-owned, allowlisting wrapper script on the remote host (never direct
 * `docker exec`, and never `docker` group membership for the SSH user —
 * see remoteDumpExecutor.ts's docker-mode dispatch for the full design).
 */
export type RemoteDumpExecMode = 'host' | 'docker';

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
  /** remote_dump only. */
  remoteDumpExecMode: RemoteDumpExecMode;
  /** remote_dump + exec_mode 'docker' only — the container name/id to `docker exec` into. */
  dockerContainer: string | null;
  /** remote_dump + exec_mode 'docker' only — the database name inside the container. */
  remoteDumpDatabase: string | null;
  /** remote_dump + exec_mode 'docker' only — the DB user to authenticate as inside the container. */
  remoteDumpDbUser: string | null;
  /**
   * remote_dump + exec_mode 'docker' only, and itself optional even then —
   * a Postgres container commonly needs no password at all (trust/peer auth
   * over its own unix socket), while MySQL/MariaDB normally does. Never
   * required for host mode, which relies on the remote user's own
   * ~/.pgpass / ~/.my.cnf instead (see the in-app SSH setup guide).
   */
  remoteDumpDbPasswordSecretRef: string | null;
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
  /** Pure visual/reporting label — see BackupSet's own doc comment. Never affects scheduling/execution. */
  backupSetId: string | null;
  /**
   * The exact Windows Scheduled Task name this task is registered under —
   * set only by a successful scheduler:install, cleared only by a
   * successful scheduler:uninstall. Non-null is this app's only signal for
   * "is this task's schedule actually active in Windows," without needing
   * a live, elevated schtasks query just to render a list — see
   * windowsTaskScheduler.ts's scheduledTaskDisplayName for why it's stored
   * rather than recomputed from the task's current name on every call.
   */
  windowsTaskName: string | null;
}

/** How a run was initiated. 'scheduled' only when invoked by `run-due` off a Windows Scheduled Task; everything else ("Ejecutar ahora", task:run) is 'manual'. */
export type RunTrigger = 'manual' | 'scheduled';

export interface BackupRun {
  id: string;
  taskId: string;
  clientId: string;
  strategy: BackupStrategyKind;
  /** See RunTrigger. Used by isTaskDue so a manual run never suppresses that day's scheduled run. */
  trigger: RunTrigger;
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
