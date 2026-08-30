/**
 * Off-site replication of backups to a cloud remote (Google Drive via
 * rclone today). A replication target is created explicitly per client and
 * per content kind; nothing replicates by default. See
 * db/migrations/0015_add_replication_targets.sql for the schema rationale.
 */

/**
 * What a target copies:
 *  - `restic_repo` -> the client's `_restic-repo` folder (already encrypted
 *    at rest; synced as raw ciphertext).
 *  - `db_dumps`    -> the client's DB-dump tree under `localBasePath`
 *    (NOT encrypted at rest; wrapped in an rclone `crypt` remote).
 */
export type ReplicationContent = 'restic_repo' | 'db_dumps';

export type ReplicationProvider = 'rclone_drive';

export type ReplicationRunStatus = 'Running' | 'Success' | 'Warning' | 'Failed';
export type ReplicationTrigger = 'manual' | 'scheduled';
export type ReplicationLastStatus = 'Success' | 'Warning' | 'Failed';

export interface ReplicationTarget {
  id: string;
  clientId: string;
  content: ReplicationContent;
  provider: ReplicationProvider;
  /** Destination folder inside the remote account, e.g. "arkode/Winners/repo". */
  remotePath: string;
  /** SecretStore ref for the rclone remote definition JSON (see RcloneDriveConfig). */
  rcloneConfigSecretRef: string;
  encryptWithCrypt: boolean;
  /** SecretStore ref for the rclone `crypt` password. Non-null iff encryptWithCrypt. */
  cryptPasswordSecretRef: string | null;
  enabled: boolean;
  lastReplicatedAt: string | null;
  lastStatus: ReplicationLastStatus | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReplicationRun {
  id: string;
  targetId: string;
  clientId: string;
  trigger: ReplicationTrigger;
  status: ReplicationRunStatus;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  bytesTransferred: number | null;
  filesTransferred: number | null;
  filesDeleted: number | null;
  errorMessage: string | null;
  pid: number | null;
  createdAt: string;
}

/**
 * The JSON stored in SecretStore under `rcloneConfigSecretRef`. `token` is
 * rclone's own OAuth token blob (from `rclone authorize "drive"`), which
 * carries its refresh token and auto-renews. The optional clientId/secret
 * let an operator supply their own Google OAuth app to avoid rclone's
 * shared-client rate limits.
 */
export interface RcloneDriveConfig {
  /** The raw `{"access_token":...,"refresh_token":...,"expiry":...}` JSON string rclone printed. */
  token: string;
  clientId?: string;
  clientSecret?: string;
  /** Optional Shared Drive id (rclone `team_drive`). */
  teamDrive?: string;
  /** Optional Drive folder id to scope into (rclone `root_folder_id`). */
  rootFolderId?: string;
}

/** Stats parsed from `rclone sync`'s final JSON-log summary. */
export interface RcloneSyncResult {
  bytesTransferred: number;
  filesTransferred: number;
  filesDeleted: number;
  warnings: string[];
}
