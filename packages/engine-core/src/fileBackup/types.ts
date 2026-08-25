import type { ScheduleFrequency } from '../types.js';

/** Only 'local_folder' exists today — 'remote_folder' is a future, separate increment. */
export type FileBackupSourceKind = 'local_folder';

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
  /** Always an absolute Windows path — resolved in Node before ever reaching restic. */
  sourcePath: string;
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
