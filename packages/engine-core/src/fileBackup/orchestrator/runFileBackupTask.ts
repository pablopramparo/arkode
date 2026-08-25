import { stat } from 'node:fs/promises';
import type { Client } from '../../types.js';
import type { ClientsRepo } from '../../db/repositories/clientsRepo.js';
import type { SecretStore } from '../../secrets/types.js';
import { createFileBackupRunLogger, type FileBackupRunLogger } from '../logging/createFileBackupRunLogger.js';
import type { FileBackupRepository, FileBackupRun, FileBackupTask } from '../types.js';
import type { FileBackupRepositoriesRepo } from '../db/repositories/fileBackupRepositoriesRepo.js';
import type { FileBackupRunsRepo } from '../db/repositories/fileBackupRunsRepo.js';
import type { FileBackupMaintenanceRunsRepo } from '../db/repositories/fileBackupMaintenanceRunsRepo.js';
import type { FileBackupRetentionDeletionsRepo } from '../db/repositories/fileBackupRetentionDeletionsRepo.js';
import { checkRepositoryLock, recoverStaleRepositoryRuns } from '../locking/repositoryLock.js';
import * as resticClient from '../restic/resticClient.js';
import { applyFileBackupRetention, resolveFileBackupRetentionPolicy } from '../retention/applyFileBackupRetention.js';

export interface RunFileBackupTaskDeps {
  clientsRepo: ClientsRepo;
  fileBackupRepositoriesRepo: FileBackupRepositoriesRepo;
  fileBackupRunsRepo: FileBackupRunsRepo;
  fileBackupMaintenanceRunsRepo: FileBackupMaintenanceRunsRepo;
  fileBackupRetentionDeletionsRepo: FileBackupRetentionDeletionsRepo;
  secretStore: SecretStore;
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

async function applyRetentionSafely(
  task: FileBackupTask,
  client: Client,
  repository: FileBackupRepository,
  deps: RunFileBackupTaskDeps,
  logger: FileBackupRunLogger,
  triggeredByRunId: string
): Promise<void> {
  try {
    const policy = resolveFileBackupRetentionPolicy(client, task);
    await applyFileBackupRetention(task, repository, policy, {
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
 * Same overall shape as orchestrator/runBackupTask.ts (status state machine,
 * stale-run recovery, a concurrency guard, retention invocation at the end)
 * but built independently — see this domain's module-level isolation note —
 * and with locking/retention scoped to the *repository* (shared by several
 * tasks) rather than the single task, since a restic repository, unlike a
 * single dump file, genuinely has shared state several tasks touch.
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

  const run = deps.fileBackupRunsRepo.create({
    taskId: task.id,
    clientId: task.clientId,
    repositoryId: task.repositoryId,
    pid: process.pid,
  });

  const logger = createFileBackupRunLogger(run.id);
  logger.log('info', 'connect', `Starting local_folder file-backup run for task "${task.name}" (client "${client.name}").`);

  try {
    deps.fileBackupRunsRepo.markProducing(run.id);

    if (!(await pathExistsAsDirectory(task.sourcePath))) {
      throw new Error(`Source folder "${task.sourcePath}" does not exist or is not a directory.`);
    }

    const password = deps.secretStore.get(repository.passwordSecretRef);
    if (!password) {
      throw new Error(`Could not resolve the password for file-backup repository ${repository.id}.`);
    }

    logger.log('info', 'produce', `Running restic backup of "${task.sourcePath}".`);
    const summary = await resticClient.runBackup(repository.repoPath, password, task.sourcePath, { tag: task.id });
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

    await applyRetentionSafely(task, client, repository, deps, logger, run.id);
    const finished = deps.fileBackupRunsRepo.getById(run.id);
    if (!finished) throw new Error(`File-backup run ${run.id} vanished after completion — this should never happen.`);
    return { run: finished, skipped: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const errorStack = err instanceof Error ? err.stack : undefined;
    deps.fileBackupRunsRepo.markFinished(run.id, 'Failed', { errorMessage: message, errorStack });
    logger.log('error', 'result', `File-backup run failed: ${message}`);

    await applyRetentionSafely(task, client, repository, deps, logger, run.id);

    const finished = deps.fileBackupRunsRepo.getById(run.id);
    if (!finished) throw err;
    return { run: finished, skipped: false };
  }
}
