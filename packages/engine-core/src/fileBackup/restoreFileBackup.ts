import type { FileBackupRun } from './types.js';
import type { FileBackupRunsRepo } from './db/repositories/fileBackupRunsRepo.js';
import type { FileBackupRepositoriesRepo } from './db/repositories/fileBackupRepositoriesRepo.js';
import type { SecretStore } from '../secrets/types.js';
import * as resticClient from './restic/resticClient.js';

export interface RestoreFileBackupDeps {
  fileBackupRunsRepo: FileBackupRunsRepo;
  fileBackupRepositoriesRepo: FileBackupRepositoriesRepo;
  secretStore: SecretStore;
}

async function resolveRunRepoAndPassword(
  runId: string,
  deps: RestoreFileBackupDeps
): Promise<{ run: FileBackupRun; repoPath: string; password: string; snapshotId: string }> {
  const run = deps.fileBackupRunsRepo.getById(runId);
  if (!run) throw new Error(`File-backup run ${runId} not found.`);
  if (!run.snapshotId) throw new Error(`File-backup run ${runId} has no snapshot to restore (status: ${run.status}).`);

  const repository = deps.fileBackupRepositoriesRepo.getById(run.repositoryId);
  if (!repository) throw new Error(`File-backup repository ${run.repositoryId} not found.`);

  const password = deps.secretStore.get(repository.passwordSecretRef);
  if (!password) throw new Error(`Could not resolve the password for file-backup repository ${repository.id}.`);

  return { run, repoPath: repository.repoPath, password, snapshotId: run.snapshotId };
}

/** Restores an entire run's snapshot to a local folder — see resticClient.restoreSnapshot for why this is disk-to-disk, not a zip-streamed download. */
export async function restoreFileBackupRun(
  runId: string,
  targetDir: string,
  deps: RestoreFileBackupDeps
): Promise<{ filesRestored: number; warning?: string }> {
  const { repoPath, password, snapshotId } = await resolveRunRepoAndPassword(runId, deps);
  return resticClient.restoreSnapshot(repoPath, password, snapshotId, targetDir);
}

/** Streams a single file from a run's snapshot to destPath. */
export async function restoreFileBackupFile(
  runId: string,
  absoluteSourceFilePath: string,
  destPath: string,
  deps: RestoreFileBackupDeps
): Promise<void> {
  const { repoPath, password, snapshotId } = await resolveRunRepoAndPassword(runId, deps);
  await resticClient.dumpFile(repoPath, password, snapshotId, absoluteSourceFilePath, destPath);
}
