import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Client } from '../../types.js';
import type { ClientsRepo } from '../../db/repositories/clientsRepo.js';
import type { TransportsRepo } from '../../db/repositories/transportsRepo.js';
import type { KnownHostsRepo } from '../../db/repositories/knownHostsRepo.js';
import type { SecretStore } from '../../secrets/types.js';
import { createSftpAdapterFromTransport } from '../../transports/sftpAdapter.js';
import { createFtpAdapterFromTransport } from '../../transports/ftpAdapter.js';
import { createFileBackupRunLogger, type FileBackupRunLogger } from '../logging/createFileBackupRunLogger.js';
import type { FileBackupRepository, FileBackupRun, FileBackupTask } from '../types.js';
import type { FileBackupRepositoriesRepo } from '../db/repositories/fileBackupRepositoriesRepo.js';
import type { FileBackupRunsRepo } from '../db/repositories/fileBackupRunsRepo.js';
import type { FileBackupMaintenanceRunsRepo } from '../db/repositories/fileBackupMaintenanceRunsRepo.js';
import type { FileBackupRetentionDeletionsRepo } from '../db/repositories/fileBackupRetentionDeletionsRepo.js';
import type { FileBackupLogEventsRepo } from '../db/repositories/fileBackupLogEventsRepo.js';
import { checkRepositoryLock, recoverStaleRepositoryRuns } from '../locking/repositoryLock.js';
import { syncRemoteFolder } from '../remoteSync/syncRemoteFolder.js';
import * as resticClient from '../restic/resticClient.js';
import { applyFileBackupRetention, resolveFileBackupRetentionPolicy } from '../retention/applyFileBackupRetention.js';
import { makeProgressReporter, type ProgressSink, type ReportProgress } from '../../progress/runProgress.js';

export interface RunFileBackupTaskDeps {
  clientsRepo: ClientsRepo;
  transportsRepo: TransportsRepo;
  knownHostsRepo: KnownHostsRepo;
  fileBackupRepositoriesRepo: FileBackupRepositoriesRepo;
  fileBackupRunsRepo: FileBackupRunsRepo;
  fileBackupMaintenanceRunsRepo: FileBackupMaintenanceRunsRepo;
  fileBackupRetentionDeletionsRepo: FileBackupRetentionDeletionsRepo;
  fileBackupLogEventsRepo: FileBackupLogEventsRepo;
  secretStore: SecretStore;
  /** An unattended run (run-due, serve) has no interactive terminal, so omitting this correctly (and intentionally) rejects any host that isn't already known — same principle as the DB-backup domain's run-due. */
  onUnknownHost?: (presented: { keyType: string; fingerprintSha256: string }) => Promise<boolean>;
  /** Receives live progress as `onProgress(run.id, progress)` — see RunProgress. Optional; omitting it makes every reportProgress call a no-op. */
  onProgress?: ProgressSink;
}

export interface RunFileBackupTaskResult {
  run: FileBackupRun;
  skipped: boolean;
}

async function pathExistsAsDirectory(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}

/**
 * `task.sourcePath` for local_folder. For remote_folder, the local staging
 * mirror path is computed here, at run time, rather than stored — mirrors
 * `resolveTargetDir()`'s "computed fresh each run" role in the DB-backup
 * orchestrator (as opposed to `_restic-repo`'s "computed once, stored"
 * pattern), which conveniently sidesteps a real chicken-and-egg problem: the
 * path wants the task's own id, which doesn't exist yet at task-creation time.
 */
function resolveSourcePath(client: Client, task: FileBackupTask): string {
  if (task.sourceKind === 'local_folder') {
    if (!task.sourcePath) throw new Error(`local_folder task ${task.id} has no sourcePath — this should never happen.`);
    return task.sourcePath;
  }
  return join(client.localBasePath, '_remote-staging', task.id);
}

async function applyRetentionSafely(
  task: FileBackupTask,
  client: Client,
  repository: FileBackupRepository,
  resolvedSourcePath: string,
  deps: RunFileBackupTaskDeps,
  logger: FileBackupRunLogger,
  triggeredByRunId: string
): Promise<void> {
  try {
    const policy = resolveFileBackupRetentionPolicy(client, task);
    await applyFileBackupRetention(task, repository, resolvedSourcePath, policy, {
      fileBackupRetentionDeletionsRepo: deps.fileBackupRetentionDeletionsRepo,
      secretStore: deps.secretStore,
      logger,
      triggeredByRunId,
    });
  } catch (err) {
    logger.log('warn', 'retention', `Retention check failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * For remote_folder tasks: recursively syncs the remote folder into the
 * local staging mirror (see syncRemoteFolder.ts — the "Capa 1" this app has
 * to build regardless of storage engine, since restic's own SFTP support is
 * repository-storage-only, never source-side). Mirrors
 * fetchExistingExecutor.ts's exact sftp-vs-ftp adapter dispatch.
 */
async function syncRemoteSourceIfNeeded(
  task: FileBackupTask,
  stagingDir: string,
  deps: RunFileBackupTaskDeps,
  logger: FileBackupRunLogger,
  reportProgress: ReportProgress
): Promise<void> {
  if (task.sourceKind !== 'remote_folder') return;
  if (!task.transportId || !task.remoteSourcePath) {
    throw new Error(`remote_folder task ${task.id} is missing transportId/remoteSourcePath — this should never happen.`);
  }

  const transport = deps.transportsRepo.getById(task.transportId);
  if (!transport) throw new Error(`Transport ${task.transportId} not found for file-backup task ${task.id}.`);

  const adapter =
    transport.type === 'ftp'
      ? createFtpAdapterFromTransport(transport, deps.secretStore)
      : createSftpAdapterFromTransport(transport, deps.secretStore, deps.knownHostsRepo, deps.onUnknownHost);

  logger.log('info', 'connect', `Connecting to ${transport.host} to sync remote folder "${task.remoteSourcePath}".`);
  reportProgress({ phase: 'connecting', fraction: null });
  await adapter.connect();
  try {
    const syncResult = await syncRemoteFolder(adapter, task.remoteSourcePath, stagingDir, {
      onProgress: (p) =>
        reportProgress({
          phase: 'syncing',
          fraction: p.bytesTotal > 0 ? p.bytesDone / p.bytesTotal : p.filesTotal > 0 ? p.filesDone / p.filesTotal : null,
          current: p.filesDone,
          total: p.filesTotal,
          unit: 'files',
          label: `Sincronizando archivos… (${p.filesDone}/${p.filesTotal})`,
        }),
    });
    logger.log(
      'info',
      'connect',
      `Synced remote folder: ${syncResult.filesAdded} new, ${syncResult.filesChanged} changed, ${syncResult.filesDeleted} deleted, ${syncResult.bytesTransferred} bytes transferred.`
    );
  } finally {
    await adapter.disconnect();
  }
}

/**
 * Same overall shape as orchestrator/runBackupTask.ts (status state machine,
 * stale-run recovery, a concurrency guard, retention invocation at the end)
 * but built independently — see this domain's module-level isolation note —
 * and with locking/retention scoped to the *repository* (shared by several
 * tasks) rather than the single task, since a restic repository, unlike a
 * single dump file, genuinely has shared state several tasks touch.
 *
 * remote_folder tasks get one extra pre-step (syncRemoteSourceIfNeeded)
 * before the rest of this function proceeds completely unchanged from
 * local_folder — resticClient.runBackup, the diff-based files_deleted
 * computation, retention — none of it cares how the folder it's backing up
 * came to be in its current state.
 */
export async function runFileBackupTask(task: FileBackupTask, deps: RunFileBackupTaskDeps): Promise<RunFileBackupTaskResult> {
  const lockDeps = { fileBackupRunsRepo: deps.fileBackupRunsRepo, fileBackupMaintenanceRunsRepo: deps.fileBackupMaintenanceRunsRepo };
  recoverStaleRepositoryRuns(lockDeps, task.repositoryId);

  const lock = checkRepositoryLock(lockDeps, task.repositoryId, 'backup');
  if (lock.locked && lock.heldBy?.kind === 'run') {
    const inProgress = deps.fileBackupRunsRepo.getById(lock.heldBy.id);
    if (inProgress) return { run: inProgress, skipped: true };
  }
  if (lock.locked) {
    // Locked by a maintenance run (prune/check) — no run row to hand back;
    // the caller (run-due / manual "ejecutar ahora") should treat this the
    // same as "try again later."
    throw new Error(`File-backup repository ${task.repositoryId} is busy with maintenance — try again shortly.`);
  }

  const client = deps.clientsRepo.getById(task.clientId);
  if (!client) throw new Error(`Client ${task.clientId} not found for file-backup task ${task.id}.`);

  const repository = deps.fileBackupRepositoriesRepo.getById(task.repositoryId);
  if (!repository) throw new Error(`File-backup repository ${task.repositoryId} not found for task ${task.id}.`);
  if (!repository.initializedAt) {
    throw new Error(
      `File-backup repository ${repository.id} has not been initialized yet — create it explicitly before running tasks against it.`
    );
  }

  const sourcePath = resolveSourcePath(client, task);

  const run = deps.fileBackupRunsRepo.create({
    taskId: task.id,
    clientId: task.clientId,
    repositoryId: task.repositoryId,
    pid: process.pid,
  });

  const logger = createFileBackupRunLogger(run.id, deps.fileBackupLogEventsRepo);
  const reportProgress = makeProgressReporter(run.id, deps.onProgress);
  logger.log('info', 'connect', `Starting ${task.sourceKind} file-backup run for task "${task.name}" (client "${client.name}").`);

  try {
    deps.fileBackupRunsRepo.markProducing(run.id);
    reportProgress({ phase: 'connecting', fraction: null });

    if (task.sourceKind === 'remote_folder') {
      await syncRemoteSourceIfNeeded(task, sourcePath, deps, logger, reportProgress);
    } else if (!(await pathExistsAsDirectory(sourcePath))) {
      throw new Error(`Source folder "${sourcePath}" does not exist or is not a directory.`);
    }

    const password = deps.secretStore.get(repository.passwordSecretRef);
    if (!password) {
      throw new Error(`Could not resolve the password for file-backup repository ${repository.id}.`);
    }

    logger.log('info', 'produce', `Running restic backup of "${sourcePath}".`);
    reportProgress({ phase: 'archiving', fraction: null });
    const summary = await resticClient.runBackup(repository.repoPath, password, sourcePath, {
      tag: task.id,
      onStatus: (s) =>
        reportProgress({
          phase: 'archiving',
          fraction: s.percentDone ?? null,
          current: s.bytesDone,
          total: s.totalBytes,
          unit: 'bytes',
          etaSeconds: s.secondsRemaining,
        }),
    });
    logger.log(
      'info',
      'produce',
      `Snapshot ${summary.snapshotId}: ${summary.filesNew} new, ${summary.filesChanged} changed, ${summary.filesUnmodified} unmodified.`
    );

    let filesDeleted = 0;
    const previousRun = deps.fileBackupRunsRepo.getLatestSuccessfulByTask(task.id);
    if (previousRun?.snapshotId) {
      try {
        const diff = await resticClient.diffSnapshots(repository.repoPath, password, previousRun.snapshotId, summary.snapshotId);
        filesDeleted = diff.filesRemoved;
      } catch (err) {
        logger.log('warn', 'validate', `Could not compute files_deleted via restic diff: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    logger.log('info', 'validate', `Validating snapshot ${summary.snapshotId}.`);
    reportProgress({ phase: 'validating', fraction: null });

    const warnings = [...summary.warnings];
    if (summary.totalFilesProcessed === 0) {
      warnings.push('The source folder was empty — the snapshot contains no files.');
    }

    deps.fileBackupRunsRepo.recordBackupSummary(run.id, {
      snapshotId: summary.snapshotId,
      filesNew: summary.filesNew,
      filesChanged: summary.filesChanged,
      filesUnmodified: summary.filesUnmodified,
      filesDeleted,
      dirsNew: summary.dirsNew,
      dirsChanged: summary.dirsChanged,
      totalFilesProcessed: summary.totalFilesProcessed,
      totalBytesProcessed: summary.totalBytesProcessed,
      dataAdded: summary.dataAdded,
      dataAddedPacked: summary.dataAddedPacked,
      warnings,
    });

    if (warnings.length > 0) {
      deps.fileBackupRunsRepo.markFinished(run.id, 'Warning', { errorMessage: warnings.join('; ') });
      logger.log('warn', 'result', `Completed with warnings: ${warnings.join('; ')}.`);
    } else {
      deps.fileBackupRunsRepo.markFinished(run.id, 'Success');
      logger.log('info', 'result', `File backup succeeded: snapshot ${summary.snapshotId}.`);
    }

    await applyRetentionSafely(task, client, repository, sourcePath, deps, logger, run.id);
    const finished = deps.fileBackupRunsRepo.getById(run.id);
    if (!finished) throw new Error(`File-backup run ${run.id} vanished after completion — this should never happen.`);
    return { run: finished, skipped: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const errorStack = err instanceof Error ? err.stack : undefined;
    deps.fileBackupRunsRepo.markFinished(run.id, 'Failed', { errorMessage: message, errorStack });
    logger.log('error', 'result', `File-backup run failed: ${message}`);

    await applyRetentionSafely(task, client, repository, sourcePath, deps, logger, run.id);

    const finished = deps.fileBackupRunsRepo.getById(run.id);
    if (!finished) throw err;
    return { run: finished, skipped: false };
  }
}
