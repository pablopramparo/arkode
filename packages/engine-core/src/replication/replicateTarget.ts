import { stat } from 'node:fs/promises';
import type { ClientsRepo } from '../db/repositories/clientsRepo.js';
import type { ReplicationRunsRepo } from '../db/repositories/replicationRunsRepo.js';
import type { ReplicationTargetsRepo } from '../db/repositories/replicationTargetsRepo.js';
import type { TransportsRepo } from '../db/repositories/transportsRepo.js';
import type { FileBackupRepositoriesRepo } from '../fileBackup/db/repositories/fileBackupRepositoriesRepo.js';
import type { RepositoryLockDeps } from '../fileBackup/locking/repositoryLock.js';
import { checkRepositoryLock, recoverStaleRepositoryRuns } from '../fileBackup/locking/repositoryLock.js';
import { isStaleInProgressRun } from '../util/processIdentity.js';
import type { SecretStore } from '../secrets/types.js';
import { listSnapshots } from '../fileBackup/restic/resticClient.js';
import { rcloneSync, withRcloneConfig } from './rcloneClient.js';
import { captureSftpHostKeys, formatHostKeyFingerprints } from './sftpHostKeyCapture.js';
import type { RcloneDriveConfig, ReplicationTarget, ReplicationTrigger, ResolvedRcloneRemote } from './types.js';

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
  transportsRepo: TransportsRepo;
  secretStore: SecretStore;
  rcloneOverride?: RcloneOps;
  /** Replaces the "can we read the restic repo?" pre-flight (restic_repo targets only). */
  preflightOverride?: (repoPath: string, password: string) => Promise<void>;
  /** Test seam for captureSftpHostKeys — production never sets this. */
  captureHostKeysOverride?: typeof captureSftpHostKeys;
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

/**
 * Resolves a target's ResolvedRcloneRemote -- either its stored
 * RcloneDriveConfig secret (rclone_drive), or an existing transport's own
 * fields/secrets (rclone_sftp/rclone_ftp). For rclone_sftp, captures and
 * persists the target's pinned host key(s) on first use (see
 * sftpHostKeyCapture.ts for why every algorithm the server supports has to
 * be captured, not just one). Shared by replicateTarget() below and the
 * engine-cli replication:test/pull commands, so there's exactly one place
 * that knows how to turn a target into something rcloneClient.ts can act on.
 */
export async function resolveRcloneRemote(
  deps: Pick<ReplicateTargetDeps, 'replicationTargetsRepo' | 'transportsRepo' | 'secretStore' | 'captureHostKeysOverride'>,
  target: ReplicationTarget
): Promise<ResolvedRcloneRemote> {
  if (target.provider === 'rclone_drive') {
    const rawConfig = target.rcloneConfigSecretRef ? deps.secretStore.get(target.rcloneConfigSecretRef) : null;
    if (!rawConfig) {
      throw new Error('This target is not authorized yet — connect a Google account first.');
    }
    let drive: RcloneDriveConfig;
    try {
      drive = JSON.parse(rawConfig) as RcloneDriveConfig;
    } catch {
      throw new Error('The stored rclone configuration is corrupt.');
    }
    return { provider: 'rclone_drive', drive };
  }

  if (!target.transportId) {
    throw new Error('This target has no linked connection configured.');
  }
  const transport = deps.transportsRepo.getById(target.transportId);
  if (!transport || !transport.isActive) {
    throw new Error('The connection this target replicates through was removed or deactivated.');
  }

  if (target.provider === 'rclone_sftp') {
    if (transport.type !== 'sftp') {
      throw new Error(`Expected an sftp connection, got "${transport.type}".`);
    }
    if (!transport.privateKeyPath) {
      throw new Error('The linked SFTP connection is missing its private key.');
    }
    const keyPassphrase = transport.passphraseSecretRef
      ? (deps.secretStore.get(transport.passphraseSecretRef) ?? undefined)
      : undefined;

    let knownHostsContent = target.sftpHostKey ?? undefined;
    if (!knownHostsContent) {
      const capture = deps.captureHostKeysOverride ?? captureSftpHostKeys;
      const result = await capture({ host: transport.host, port: transport.port });
      knownHostsContent = result.knownHostsContent;
      deps.replicationTargetsRepo.setSftpHostKey(
        target.id,
        result.knownHostsContent,
        formatHostKeyFingerprints(result.entries)
      );
    }

    return {
      provider: 'rclone_sftp',
      sftp: {
        host: transport.host,
        port: transport.port,
        username: transport.username,
        privateKeyPath: transport.privateKeyPath,
        keyPassphrase,
        knownHostsContent,
      },
    };
  }

  // rclone_ftp
  if (transport.type !== 'ftp') {
    throw new Error(`Expected an ftp connection, got "${transport.type}".`);
  }
  const password = transport.passwordSecretRef ? deps.secretStore.get(transport.passwordSecretRef) : null;
  if (!password) {
    throw new Error('The linked FTP connection is missing its password.');
  }
  return {
    provider: 'rclone_ftp',
    ftp: { host: transport.host, port: transport.port, username: transport.username, password },
  };
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

  // --- Remote connection material --------------------------------------
  let remote: ResolvedRcloneRemote;
  try {
    remote = await resolveRcloneRemote(deps, target);
  } catch (err) {
    return recordImmediateFailure(deps, target, opts, msg(err));
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

    const result = await rclone.withRcloneConfig(target, remote, cryptPassword, (configPath, remoteSection) =>
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
      // Keep the warning text on the run itself, not only on the target's
      // lastError — otherwise a Warning row in the history gives no clue why.
      errorMessage: result.warnings.length > 0 ? result.warnings.join('; ') : undefined,
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
