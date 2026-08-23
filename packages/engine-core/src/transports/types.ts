export type TransportKind = 'sftp' | 'ssh';

export interface RemoteFile {
  remotePath: string;
  fileName: string;
  size: number;
  /** Best-effort remote mtime — never treated as authoritative, see orchestrator notes. */
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
}

/** remote_dump strategy (not implemented in this slice): we generate the backup on the remote host first. */
export interface SshAdapter extends TransportAdapter {
  kind: 'ssh';
  runCommand(command: string, opts?: { timeoutMs?: number }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  locateProducedFile(expectedRemotePath: string): Promise<RemoteFile>;
  removeRemoteFile(remotePath: string): Promise<void>;
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
  onUnknownHost?: (presented: { keyType: string; fingerprintSha256: string }) => Promise<boolean>;
}

export interface SftpTransportConfig extends BaseTransportConfig {
  remotePath: string;
  remoteFilePattern?: RegExp;
}

export interface SshTransportConfig extends BaseTransportConfig {
  remoteCommand: string;
  remoteOutputPathTemplate: string;
  remoteCleanup: boolean;
}
