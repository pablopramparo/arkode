import { stat } from 'node:fs/promises';
import type { ClientsRepo } from '../db/repositories/clientsRepo.js';
import type { ReplicationRunsRepo } from '../db/repositories/replicationRunsRepo.js';
import type { ReplicationTargetsRepo } from '../db/repositories/replicationTargetsRepo.js';
import type { FileBackupRepositoriesRepo } from '../fileBackup/db/repositories/fileBackupRepositoriesRepo.js';
import type { RepositoryLockDeps } from '../fileBackup/locking/repositoryLock.js';
import { checkRepositoryLock, recoverStaleRepositoryRuns } from '../fileBackup/locking/repositoryLock.js';
import { isStaleInProgressRun } from '../util/processIdentity.js';
import type { SecretStore } from '../secrets/types.js';
import { listSnapshots } from '../fileBackup/restic/resticClient.js';
import { rcloneSync, withRcloneConfig } from './rcloneClient.js';
import type { RcloneDriveConfig, ReplicationTarget, ReplicationTrigger } from './types.js';

/** Test seam — production never sets `rcloneOverride`/`preflightOverride`. */
export interface RcloneOps {
  withRcloneConfig: typeof withRcloneConfig;
  sync: typeof rcloneSync;
}

export interface ReplicateTargetDeps extends RepositoryLockDeps {
  replicationTargetsRepo: ReplicationTargetsRepo;
  replicationRunsRepo: ReplicationRunsRepo;
  clientsRepo: ClientsRepo;
  fileBackupRepositoriesRepo: FileBackupRepositoriesRepo;
  secretStore: SecretStore;
  rcloneOverride?: RcloneOps;
  /** Replaces the "can we read the restic repo?" pre-flight (restic_repo targets only). */
  preflightOverride?: (repoPath: string, password: string) => Promise<void>;
}

export interface ReplicateTargetOptions {
  trigger: ReplicationTrigger;
}

export interface ReplicateTargetResult {
  /** false => nothing was attempted (target disabled, or repository/target busy). */
  ran: boolean;
  status: 'Success' | 'Warning' | 'Failed' | 'Skipped';
  runId?: string;
  bytesTransferred?: number;
  filesTransferred?: number;
  filesDeleted?: number;
  message?: string;
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const DB_DUMPS_EXCLUDES = [
  '--exclude',
  '_restic-repo/**',
  '--exclude',
  '_remote-staging/**',
];

/**
 * Replicates one target's content to its configured Google Drive folder via
 * `rclone sync`. Runs only AFTER a backup has finished — never touches the
 * backup orchestrators. Isolates every failure into the target's own
 * `replication_runs` row + `last_status`; callers (the scheduler tick, the
 * CLI) never see a throw for an ordinary "sync failed" outcome.
 */
export async function replicateTarget(
  deps: ReplicateTargetDeps,
  targetId: string,
  opts: ReplicateTargetOptions
): Promise<ReplicateTargetResult> {
  const rclone: RcloneOps = deps.rcloneOverride ?? { withRcloneConfig, sync: rcloneSync };

  const target = deps.replicationTargetsRepo.getById(targetId);
  if (!target) throw new Error(`Replication target ${targetId} not found.`);
  if (!target.enabled) return { ran: false, status: 'Skipped', message: 'Target is disabled.' };

  const client = deps.clientsRepo.getById(target.clientId);
  if (!client) throw new Error(`Client ${target.clientId} for replication target ${targetId} not found.`);

  const repo = deps.fileBackupRepositoriesRepo.getByClientId(target.clientId);

  // --- Resolve what to sync ------------------------------------------------
  let source: string;
  let extraArgs: string[] | undefined;
  let lockRepoId: string | null = null;
  let preflight: (() => Promise<void>) | null = null;

  if (target.content === 'restic_repo') {
    if (!repo || !repo.initializedAt) {
      return recordImmediateFailure(deps, target, opts, 'This client has no initialized restic repository to replicate.');
    }
    source = repo.repoPath;
    lockRepoId = repo.id;
    const repoPassword = deps.secretStore.get(repo.passwordSecretRef);
    if (!repoPassword) {
      return recordImmediateFailure(deps, target, opts, 'The restic repository password could not be read from secret storage.');
    }
    preflight = deps.preflightOverride
      ? () => deps.preflightOverride!(repo.repoPath, repoPassword)
      : async () => {
          await listSnapshots(repo.repoPath, repoPassword);
        };
  } else {
    source = client.localBasePath;
    extraArgs = DB_DUMPS_EXCLUDES;
    // If the client also has a restic repo under the same base path, take
    // its lock too so a dumps sync can't race a repo backup/prune.
    lockRepoId = repo?.id ?? null;
    preflight = async () => {
      try {
        const s = await stat(source);
        if (!s.isDirectory()) throw new Error('not a directory');
      } catch {
        throw new Error(`The client's local backup folder does not exist yet: ${source}`);
      }
    };
  }

  // --- Concurrency guard -------------------------------------------------
  if (lockRepoId) {
    recoverStaleRepositoryRuns(deps, lockRepoId);
    const lock = checkRepositoryLock(deps, lockRepoId, 'replicate');
    if (lock.locked) {
      return { ran: false, status: 'Skipped', message: `Repository busy (${lock.heldBy?.kind}).` };
    }
  }
  for (const inProgress of deps.replicationRunsRepo.listInProgressByTarget(targetId)) {
    if (isStaleInProgressRun(inProgress)) {
      deps.replicationRunsRepo.markFinished(inProgress.id, 'Failed', {
        errorMessage: 'Replication interrupted: owning process is no longer alive.',
      });
    } else {
      return { ran: false, status: 'Skipped', message: 'A replication for this target is already running.' };
    }
  }

  // --- Secrets --------------------------------------------------------------
  const rawConfig = deps.secretStore.get(target.rcloneConfigSecretRef);
  if (!rawConfig) {
    return recordImmediateFailure(
      deps,
      target,
      opts,
      'This target is not authorized yet — connect a Google account first.'
    );
  }
  let drive: RcloneDriveConfig;
  try {
    drive = JSON.parse(rawConfig) as RcloneDriveConfig;
  } catch {
    return recordImmediateFailure(deps, target, opts, 'The stored rclone configuration is corrupt.');
  }
  let cryptPassword: string | undefined;
  if (target.encryptWithCrypt) {
    cryptPassword = target.cryptPasswordSecretRef ? deps.secretStore.get(target.cryptPasswordSecretRef) ?? undefined : undefined;
    if (!cryptPassword) {
      return recordImmediateFailure(deps, target, opts, 'The encryption password for this target could not be read.');
    }
  }

  // --- Run ---------------------------------------------------------------
  const run = deps.replicationRunsRepo.create({
    targetId,
    clientId: target.clientId,
    trigger: opts.trigger,
    pid: process.pid,
  });

  try {
    if (preflight) await preflight();

    const result = await rclone.withRcloneConfig(target, { drive, cryptPassword }, (configPath, remoteSection) =>
      rclone.sync({
        configPath,
        remoteSection,
        source,
        remotePath: target.remotePath,
        backupDir: `${remoteSection}:arkode/_trash/${run.id}`,
        extraArgs,
      })
    );

    const status: 'Success' | 'Warning' = result.warnings.length > 0 ? 'Warning' : 'Success';
    deps.replicationRunsRepo.markFinished(run.id, status, {
      bytesTransferred: result.bytesTransferred,
      filesTransferred: result.filesTransferred,
      filesDeleted: result.filesDeleted,
    });
    deps.replicationTargetsRepo.recordResult(
      targetId,
      status,
      result.warnings.length > 0 ? result.warnings.join('; ') : null
    );
    return {
      ran: true,
      status,
      runId: run.id,
      bytesTransferred: result.bytesTransferred,
      filesTransferred: result.filesTransferred,
      filesDeleted: result.filesDeleted,
      message: result.warnings.join('; ') || undefined,
    };
  } catch (err) {
    const m = msg(err);
    deps.replicationRunsRepo.markFinished(run.id, 'Failed', { errorMessage: m });
    deps.replicationTargetsRepo.recordResult(targetId, 'Failed', m);
    return { ran: true, status: 'Failed', runId: run.id, message: m };
  }
}

/**
 * Records a Failed replication_run + target status for a problem detected
 * before rclone was ever invoked (misconfiguration, missing repo, etc.), so
 * the UI surfaces it the same way as a real sync failure.
 */
function recordImmediateFailure(
  deps: ReplicateTargetDeps,
  target: ReplicationTarget,
  opts: ReplicateTargetOptions,
  message: string
): ReplicateTargetResult {
  const run = deps.replicationRunsRepo.create({
    targetId: target.id,
    clientId: target.clientId,
    trigger: opts.trigger,
    pid: process.pid,
  });
  deps.replicationRunsRepo.markFinished(run.id, 'Failed', { errorMessage: message });
  deps.replicationTargetsRepo.recordResult(target.id, 'Failed', message);
  return { ran: true, status: 'Failed', runId: run.id, message };
}
