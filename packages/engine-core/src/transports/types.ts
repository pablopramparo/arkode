export type TransportKind = 'sftp' | 'ssh' | 'ftp';

export interface RemoteFile {
  remotePath: string;
  fileName: string;
  size: number;
  /** Best-effort remote mtime — never treated as authoritative, see orchestrator notes. */
  modifiedAt: Date;
}

/**
 * One file discovered by a recursive `listRemoteTree` walk (remote_folder
 * file-backup sync — see fileBackup/remoteSync/syncRemoteFolder.ts).
 * Directories are traversed internally but never appear in the result —
 * the sync algorithm creates local parent directories on demand instead.
 */
export interface RemoteTreeEntry {
  /** POSIX-style, relative to the listed root, e.g. "sub/dir/file.txt" — never an absolute remote path. */
  relativePath: string;
  size: number;
  modifiedAt: Date;
}

export interface DownloadResult {
  bytesTransferred: number;
  /** Computed incrementally while streaming — never a second read pass. */
  sha256: string;
}

export interface DownloadOptions {
  onProgress?: (transferred: number, total: number) => void;
  signal?: AbortSignal;
}

export interface ConnectionTestResult {
  ok: boolean;
  message: string;
  latencyMs?: number;
  /**
   * The remote server's own reported version, when the connection is a
   * database one — e.g. "18.0" (Postgres' `server_version`) or "10.11.6-MariaDB"
   * (MySQL/MariaDB's `VERSION()`, which conveniently distinguishes the two
   * products in the string itself). Never populated for transport (SFTP/SSH)
   * tests, or if the version query itself failed for some reason even though
   * the connectivity check passed. See "direct_dump tool version management"
   * in CLAUDE.md — this is groundwork for a future compatibility gate, not
   * the gate itself.
   */
  serverVersion?: string;
  /** The local CLI tool's own reported version (`psql --version` / `mysql --version`), for eyeballing alongside serverVersion — same scope caveat as above. */
  localToolVersion?: string;
  /**
   * Set only when the connection failed specifically because the remote
   * host's key isn't trusted — either genuinely never seen before, or
   * already in knownHosts under a *different* fingerprint (the server's
   * host key rotated, e.g. after a reprovision) — and either no
   * onUnknownHost handler was supplied or it declined. Never set for any
   * other kind of failure. Lets a caller that can't do an interactive
   * terminal prompt (the UI, going through serve) show its own "trust this
   * host?" confirmation and retry with trustHost instead, rather than the
   * raw ssh2 "Host denied (verification failed)" error being the end of the
   * story. previousFingerprintSha256 is set only for the "key changed" case,
   * so the caller can warn more strongly than for a first-time trust.
   */
  unknownHost?: { keyType: string; fingerprintSha256: string; previousFingerprintSha256?: string };
}

/** Capability every transport adapter provides, regardless of kind. */
export interface TransportAdapter {
  readonly kind: TransportKind;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  testConnection(): Promise<ConnectionTestResult>;
  /**
   * Downloads `remote` to `localTempPath`. The caller (a strategy executor)
   * owns the `.part` naming convention and the final rename-after-validation.
   */
  downloadFile(remote: RemoteFile, localTempPath: string, opts?: DownloadOptions): Promise<DownloadResult>;
}

/** fetch_existing strategy: backups already exist remotely — we only discover and fetch them. */
export interface SftpAdapter extends TransportAdapter {
  kind: 'sftp';
  listRemoteFiles(remoteDir: string, pattern?: RegExp): Promise<RemoteFile[]>;
  /** remote_folder file-backup sync only — recursively lists every file under remoteDir. Symlinks are skipped, not followed. */
  listRemoteTree(remoteDir: string): Promise<RemoteTreeEntry[]>;
}

/** remote_dump strategy (not implemented in this slice): we generate the backup on the remote host first. */
export interface SshAdapter extends TransportAdapter {
  kind: 'ssh';
  /**
   * `opts.stdin`, when set, is written to the remote command's stdin and the
   * stream is then closed (EOF) — the one channel a secret value can travel
   * over without ever appearing in argv/`ps aux`/`/proc/*\/cmdline` on the
   * remote host, unlike a CLI flag baked into `command` itself (which, once
   * that command reaches the remote login shell as `$SHELL -c "<command>"`,
   * would sit in that shell process's own argv for its whole lifetime). See
   * remoteDumpExecutor.ts's docker-mode dump-password handling for the real
   * use case this exists for.
   */
  runCommand(command: string, opts?: { timeoutMs?: number; stdin?: string }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  locateProducedFile(expectedRemotePath: string): Promise<RemoteFile>;
  removeRemoteFile(remotePath: string): Promise<void>;
}

/**
 * fetch_existing strategy, same role as SftpAdapter — plain FTP (no
 * SFTP/FTPS/TLS), for a remote host that only exposes an old-style FTP
 * server for its existing dumps. Deliberately a separate kind, not an
 * SftpAdapter variant: FTP authenticates with a username+password, not an
 * SSH key, and has no host-key concept at all, so the config/adapter shape
 * genuinely differs rather than just the wire protocol underneath.
 */
export interface FtpAdapter extends TransportAdapter {
  kind: 'ftp';
  listRemoteFiles(remoteDir: string, pattern?: RegExp): Promise<RemoteFile[]>;
  /** remote_folder file-backup sync only — recursively lists every file under remoteDir. Symlinks are skipped, not followed. */
  listRemoteTree(remoteDir: string): Promise<RemoteTreeEntry[]>;
}

export interface BaseTransportConfig {
  host: string;
  port: number;
  username: string;
  privateKeyPath: string;
  /** Resolved from SecretStore by the caller — never read from disk here. */
  passphrase?: string;
  /** Pinned fingerprint; undefined means "unknown host, ask before proceeding." */
  knownHostFingerprint?: string;
  onUnknownHost?: (presented: {
    keyType: string;
    fingerprintSha256: string;
    previousFingerprintSha256?: string;
  }) => Promise<boolean>;
}

export interface SftpTransportConfig extends BaseTransportConfig {
  /** Only used by testConnection()'s connectivity smoke-listing — the real remote directory to work with is task-level now (BackupTask.remotePath), not part of the transport connection. */
  remotePath?: string;
}

export interface SshTransportConfig extends BaseTransportConfig {}

/**
 * Deliberately not a BaseTransportConfig variant — that base bundles
 * privateKeyPath/host-key verification, neither of which applies to FTP.
 */
export interface FtpTransportConfig {
  host: string;
  port: number;
  username: string;
  /** Resolved from SecretStore by the caller — never read from disk here. Undefined means anonymous FTP. */
  password?: string;
  /** Only used by testConnection()'s connectivity smoke-listing — see SftpTransportConfig's note. */
  remotePath?: string;
}
