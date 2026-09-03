import type { BackupStrategyKind, BackupTask, Client } from '../types.js';
import type { ReportProgress } from '../progress/runProgress.js';

export interface ProducedDump {
  /** A not-yet-validated local file; the orchestrator owns renaming it off `.part`. */
  localTempPath: string;
  fileName: string;
  sizeBytes: number;
  /** Best-effort; never treated as authoritative — see orchestrator notes on remote-mtime trust. */
  sourceModifiedAt?: Date;
  /**
   * Populated only if the strategy can compute SHA-256 during produce() at no
   * extra read cost (e.g. while streaming a download). If left undefined,
   * the orchestrator computes it once itself on the temp file as a fallback —
   * see runBackupTask.ts. Either path hashes the file exactly once.
   */
  checksumSha256?: string;
}

export interface BackupStrategyContext {
  task: BackupTask;
  client: Client;
  /** Directory that will hold the final validated file, e.g. Backups/{client}/{db}/{YYYY}/{MM}. Already created. */
  targetDir: string;
  /** Report live progress for the UI. A no-op when the caller wired no sink — executors call it unconditionally. */
  reportProgress: ReportProgress;
}

/**
 * The orchestrator depends only on this interface, never on a transport or
 * database-connection type directly — that's what lets remote_dump and
 * direct_dump be added later as new executors without reshaping the pipeline.
 */
export interface BackupStrategyExecutor {
  readonly kind: BackupStrategyKind;
  produce(ctx: BackupStrategyContext): Promise<ProducedDump>;
}

/**
 * Not a failure: the strategy checked and there is genuinely nothing new to
 * fetch/generate (e.g. fetch_existing's latest remote file is already
 * downloaded and validated). The orchestrator treats this as a successful
 * no-op run rather than a Failed one.
 */
export class NoNewDumpAvailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoNewDumpAvailableError';
  }
}
