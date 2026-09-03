import type { ScheduleFrequency, RunProgress } from '../types.js';

export type FileBackupSourceKind = 'local_folder' | 'remote_folder';

export type FileBackupRunStatus = 'Pending' | 'Running' | 'Producing' | 'Validating' | 'Success' | 'Warning' | 'Failed';

export type FileBackupMaintenanceOperation = 'prune' | 'check' | 'check_read_data';
export type FileBackupMaintenanceStatus = 'Running' | 'Success' | 'Warning' | 'Failed';

export interface FileBackupRepository {
  id: string;
  clientId: string;
  repoPath: string;
  passwordSecretRef: string;
  resticRepoId: string | null;
  lastPrunedAt: string | null;
  lastCheckedAt: string | null;
  /** Null until `restic init` has actually succeeded against repoPath. */
  initializedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FileBackupTask {
  id: string;
  clientId: string;
  repositoryId: string;
  name: string;
  sourceKind: FileBackupSourceKind;
  /** local_folder only — always an absolute Windows path, resolved in Node before ever reaching restic. NULL for remote_folder, whose local staging mirror is computed at run time instead (see runFileBackupTask.ts's resolveSourcePath). */
  sourcePath: string | null;
  /** remote_folder only — the sftp/ftp transport used to pull from remoteSourcePath. NULL for local_folder. */
  transportId: string | null;
  /** remote_folder only — the folder's path on the remote host. NULL for local_folder. */
  remoteSourcePath: string | null;
  retentionCount: number | null;
  retentionDays: number | null;
  scheduleTime: string | null;
  scheduleEnabled: boolean;
  scheduleFrequency: ScheduleFrequency;
  scheduleDaysOfWeek: number[] | null;
  scheduleDayOfMonth: number | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  /** Pure visual/reporting label — see BackupSet's own doc comment in the DB-backup domain's types.ts. Never affects scheduling/execution. */
  backupSetId: string | null;
  /** Set by a successful `file-task:scheduler:install`, cleared by `:uninstall` — see 0014's migration comment. Non-null means "registered in Windows Task Scheduler". */
  windowsTaskName: string | null;
}

export interface FileBackupRun {
  id: string;
  taskId: string;
  clientId: string;
  repositoryId: string;
  status: FileBackupRunStatus;
  snapshotId: string | null;
  filesNew: number | null;
  filesChanged: number | null;
  filesUnmodified: number | null;
  filesDeleted: number | null;
  dirsNew: number | null;
  dirsChanged: number | null;
  totalFilesProcessed: number | null;
  totalBytesProcessed: number | null;
  dataAdded: number | null;
  dataAddedPacked: number | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  errorMessage: string | null;
  errorStack: string | null;
  warnings: string[] | null;
  logFilePath: string | null;
  pid: number | null;
  createdAt: string;
  /** Live progress while in-progress; null otherwise (and possibly stale — see RunProgress). */
  progress: RunProgress | null;
}

export interface FileBackupRetentionDeletion {
  id: string;
  taskId: string;
  forgottenSnapshotId: string;
  triggeredByRunId: string | null;
  reason: string;
  forgottenAt: string;
}

export interface FileBackupMaintenanceRun {
  id: string;
  repositoryId: string;
  operation: FileBackupMaintenanceOperation;
  status: FileBackupMaintenanceStatus;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  bytesReclaimed: number | null;
  errorMessage: string | null;
  pid: number | null;
  createdAt: string;
}

/** Mirrors `restic backup --json`'s final `message_type:"summary"` line. */
export interface ResticBackupSummary {
  snapshotId: string;
  filesNew: number;
  filesChanged: number;
  filesUnmodified: number;
  dirsNew: number;
  dirsChanged: number;
  totalFilesProcessed: number;
  totalBytesProcessed: number;
  dataAdded: number;
  dataAddedPacked: number;
  durationMs: number;
  /** Non-fatal issues restic reported during the backup (e.g. a skipped unreadable file). */
  warnings: string[];
}

/** Mirrors `restic diff --json`'s final `message_type:"statistics"` line. */
export interface ResticDiffStats {
  filesAdded: number;
  filesRemoved: number;
  filesChanged: number;
}

export interface ResticSnapshot {
  id: string;
  time: string;
  paths: string[];
  tags: string[];
}
