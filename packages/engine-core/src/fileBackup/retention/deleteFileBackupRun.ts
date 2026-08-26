import type { FileBackupRunsRepo } from '../db/repositories/fileBackupRunsRepo.js';
import type { FileBackupRepositoriesRepo } from '../db/repositories/fileBackupRepositoriesRepo.js';
import type { FileBackupRetentionDeletionsRepo } from '../db/repositories/fileBackupRetentionDeletionsRepo.js';
import type { FileBackupMaintenanceRunsRepo } from '../db/repositories/fileBackupMaintenanceRunsRepo.js';
import type { SecretStore } from '../../secrets/types.js';
import { checkRepositoryLock, recoverStaleRepositoryRuns } from '../locking/repositoryLock.js';
import * as resticClient from '../restic/resticClient.js';

export interface DeleteFileBackupRunDeps {
  fileBackupRunsRepo: FileBackupRunsRepo;
  fileBackupRepositoriesRepo: FileBackupRepositoriesRepo;
  fileBackupRetentionDeletionsRepo: FileBackupRetentionDeletionsRepo;
  fileBackupMaintenanceRunsRepo: FileBackupMaintenanceRunsRepo;
  secretStore: SecretStore;
}

/**
 * Forgets one specific snapshot on explicit human request — the file-backup
 * domain's equivalent of retention/deleteBackupRun.ts. Uses resticClient's
 * forgetSnapshot() (the positional-ID form), not the policy-based forget()
 * automated retention uses, since a manual delete deliberately isn't bound
 * by the `--keep-last 1` survivor floor that protects automated retention.
 * Acquires the same repository-level lock backup/prune/check already share
 * (operation kind 'forget', already a first-class member of
 * FileBackupOperationKind for exactly this) so a manual delete can never
 * race a concurrent backup or maintenance sweep.
 *
 * Does not touch the file_backup_runs row itself, and does not reclaim disk
 * space — matching automated retention's own applyFileBackupRetention.ts
 * exactly; that's prune's separate, later job.
 */
export async function deleteFileBackupRun(runId: string, deps: DeleteFileBackupRunDeps): Promise<{ deleted: boolean }> {
  const run = deps.fileBackupRunsRepo.getById(runId);
  if (!run) throw new Error(`File-backup run ${runId} not found.`);
  if (!run.snapshotId) throw new Error(`Run ${runId} has no snapshot to delete.`);

  const repository = deps.fileBackupRepositoriesRepo.getById(run.repositoryId);
  if (!repository) throw new Error(`Repository ${run.repositoryId} not found.`);

  const lockDeps = { fileBackupRunsRepo: deps.fileBackupRunsRepo, fileBackupMaintenanceRunsRepo: deps.fileBackupMaintenanceRunsRepo };
  recoverStaleRepositoryRuns(lockDeps, repository.id);
  const lock = checkRepositoryLock(lockDeps, repository.id, 'forget');
  if (lock.locked) throw new Error('This repository is currently busy with another backup or maintenance operation — try again shortly.');

  const password = deps.secretStore.get(repository.passwordSecretRef);
  if (!password) throw new Error('Could not resolve the repository password.');

  await resticClient.forgetSnapshot(repository.repoPath, password, run.snapshotId);

  deps.fileBackupRetentionDeletionsRepo.create({
    taskId: run.taskId,
    forgottenSnapshotId: run.snapshotId,
    triggeredByRunId: null,
    reason: 'manual_delete',
  });

  return { deleted: true };
}
