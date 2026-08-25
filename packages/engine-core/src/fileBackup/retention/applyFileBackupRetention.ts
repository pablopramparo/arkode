import type { Client } from '../../types.js';
import type { FileBackupRepository, FileBackupTask } from '../types.js';
import type { FileBackupRetentionDeletionsRepo } from '../db/repositories/fileBackupRetentionDeletionsRepo.js';
import type { FileBackupRunLogger } from '../logging/createFileBackupRunLogger.js';
import type { SecretStore } from '../../secrets/types.js';
import * as resticClient from '../restic/resticClient.js';

export interface FileBackupRetentionPolicy {
  count: number | null;
  days: number | null;
}

/**
 * Task-level policy overrides the client-level default; neither set means
 * "no retention." Deliberately duplicated from retention/applyRetention.ts's
 * resolveRetentionPolicy rather than imported — see this domain's module-
 * level isolation note.
 */
export function resolveFileBackupRetentionPolicy(client: Client, task: FileBackupTask): FileBackupRetentionPolicy {
  return {
    count: task.retentionCount ?? client.retentionCount ?? null,
    days: task.retentionDays ?? client.retentionDays ?? null,
  };
}

export interface ApplyFileBackupRetentionDeps {
  fileBackupRetentionDeletionsRepo: FileBackupRetentionDeletionsRepo;
  secretStore: SecretStore;
  logger: FileBackupRunLogger;
  triggeredByRunId: string | null;
}

/**
 * Runs `restic forget` (see resticClient.ts for the exact flags — always
 * scoped to this task's own sourcePath, always unions in a `--keep-last 1`
 * floor) and records every snapshot restic reports as removed into
 * file_backup_retention_deletions, mirroring applyRetention.ts's audit
 * trail for the DB-backup domain. No policy configured → skip entirely,
 * identical to today's DB-backup behavior.
 *
 * Deliberately does *not* run `prune` — forgetting a snapshot only
 * dereferences it; reclaiming the actual disk space is separate repository
 * maintenance with its own schedule (see maintenance/runFileBackupMaintenance.ts).
 */
export async function applyFileBackupRetention(
  task: FileBackupTask,
  repository: FileBackupRepository,
  policy: FileBackupRetentionPolicy,
  deps: ApplyFileBackupRetentionDeps
): Promise<void> {
  if (policy.count == null && policy.days == null) return;

  const password = deps.secretStore.get(repository.passwordSecretRef);
  if (!password) {
    deps.logger.log('warn', 'retention', `Skipping retention: could not resolve the repository password.`);
    return;
  }

  const { removedSnapshotIds } = await resticClient.forget(repository.repoPath, password, {
    path: task.sourcePath,
    keepLast: policy.count ?? undefined,
    keepWithinDays: policy.days ?? undefined,
  });

  for (const snapshotId of removedSnapshotIds) {
    deps.fileBackupRetentionDeletionsRepo.create({
      taskId: task.id,
      forgottenSnapshotId: snapshotId,
      triggeredByRunId: deps.triggeredByRunId,
      reason: policy.count != null && policy.days != null ? 'retention_count_and_days' : policy.count != null ? 'retention_count' : 'retention_days',
    });
    deps.logger.log('info', 'retention', `Forgot old snapshot ${snapshotId}.`);
  }
}
