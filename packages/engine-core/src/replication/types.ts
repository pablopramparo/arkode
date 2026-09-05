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

export type ReplicationProvider = 'rclone_drive' | 'rclone_sftp' | 'rclone_ftp';

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
  /** rclone_drive only: SecretStore ref for the rclone remote definition JSON (see RcloneDriveConfig). */
  rcloneConfigSecretRef: string | null;
  /** rclone_sftp/rclone_ftp only: an existing transports row supplies host/port/username + credentials. */
  transportId: string | null;
  /** rclone_sftp only: the pinned host key (rclone `host_keys` format, "algo base64key"), captured on first use. */
  sftpHostKey: string | null;
  /** rclone_sftp only: SHA256 fingerprint of the same key, for display only. */
  sftpHostKeyFingerprint: string | null;
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

/** rclone_sftp remote material, resolved from an existing sftp-type transport + its secrets. */
export interface RcloneSftpRemoteMaterial {
  host: string;
  port: number;
  username: string;
  /** Path to the PEM-encoded private key file (transports.private_key_path). */
  privateKeyPath: string;
  /** Plaintext passphrase for the key, if any (resolved from transports.passphrase_secret_ref). */
  keyPassphrase?: string;
  /** Pinned host key(s), as real OpenSSH known_hosts-format line(s), once captured. */
  knownHostsContent?: string;
}

/** rclone_ftp remote material, resolved from an existing ftp-type transport + its secret. */
export interface RcloneFtpRemoteMaterial {
  host: string;
  port: number;
  username: string;
  /** Plaintext password (resolved from transports.password_secret_ref). */
  password: string;
}

/**
 * The remote connection material `rcloneConfig.ts`/`rcloneClient.ts` need to
 * build a temp rclone.conf, resolved by the caller (replicateTarget.ts / the
 * engine-cli replication:* commands) from whichever source the target's
 * provider dictates -- a stored RcloneDriveConfig secret, or an existing
 * transport's own fields/secrets.
 */
export type ResolvedRcloneRemote =
  | { provider: 'rclone_drive'; drive: RcloneDriveConfig }
  | { provider: 'rclone_sftp'; sftp: RcloneSftpRemoteMaterial }
  | { provider: 'rclone_ftp'; ftp: RcloneFtpRemoteMaterial };
