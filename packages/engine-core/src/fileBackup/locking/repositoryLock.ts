import type { FileBackupRunsRepo } from '../db/repositories/fileBackupRunsRepo.js';
import type { FileBackupMaintenanceRunsRepo } from '../db/repositories/fileBackupMaintenanceRunsRepo.js';
// Domain-neutral OS helper (src/util), not the DB-backup orchestrator's
// internals — importing it doesn't violate this domain's "don't reach into
// tested DB-backup code" rule. A bare process.kill(pid,0) is not enough:
// a recycled PID would keep a crashed run stuck forever (see the helper).
import { isStaleInProgressRun } from '../../util/processIdentity.js';

export type FileBackupOperationKind = 'backup' | 'forget' | 'prune' | 'check' | 'check_read_data';

export interface RepositoryLockDeps {
  fileBackupRunsRepo: FileBackupRunsRepo;
  fileBackupMaintenanceRunsRepo: FileBackupMaintenanceRunsRepo;
}

export interface RepositoryLockResult {
  locked: boolean;
  heldBy?: { kind: 'run' | 'maintenance'; id: string };
}

/**
 * Recovers from a crash mid-run: any in-progress row (task run or
 * maintenance run) for this repository whose pid is no longer alive is not
 * actually in progress — mark it Failed so it doesn't block the lock check
 * below forever. Mirrors runBackupTask.ts's recoverStaleRuns, scoped to a
 * repository instead of a single task since locking here spans every task
 * sharing that repository (see checkRepositoryLock's own doc comment).
 */
export function recoverStaleRepositoryRuns(deps: RepositoryLockDeps, repositoryId: string): void {
  for (const run of deps.fileBackupRunsRepo.listInProgressByRepository(repositoryId)) {
    if (!isStaleInProgressRun(run)) continue;
    deps.fileBackupRunsRepo.markFinished(run.id, 'Failed', {
      errorMessage: 'Run interrupted: owning process is no longer alive.',
    });
  }
  for (const maintenanceRun of deps.fileBackupMaintenanceRunsRepo.listInProgressByRepository(repositoryId)) {
    if (!isStaleInProgressRun(maintenanceRun)) continue;
    deps.fileBackupMaintenanceRunsRepo.markFinished(maintenanceRun.id, 'Failed', {
      errorMessage: 'Maintenance run interrupted: owning process is no longer alive.',
    });
  }
}

/**
 * Deliberately stricter than restic itself needs — the PoC proved restic
 * safely supports two concurrent `backup` writers against one repository.
 * This serializes *everything* against a repository regardless of operation
 * kind (including two ordinary backups from different tasks of the same
 * client), an intentional Arkode-side simplification for this increment —
 * less scheduling/I/O complexity, and it composes more predictably with the
 * future remote_folder pull step — not a workaround for a restic limitation.
 *
 * Kept encapsulated behind an explicit `operation` parameter specifically so
 * this can be relaxed later (e.g. allowing two concurrent 'backup'
 * operations, while still requiring true exclusivity for 'prune'/'check')
 * without any call site changing: every caller already passes the right
 * operation kind today, even though today's implementation ignores it and
 * blocks on *any* in-progress row regardless of kind.
 */
export function checkRepositoryLock(
  deps: RepositoryLockDeps,
  repositoryId: string,
  _operation: FileBackupOperationKind
): RepositoryLockResult {
  const inProgressRuns = deps.fileBackupRunsRepo
    .listInProgressByRepository(repositoryId)
    .filter((run) => !isStaleInProgressRun(run));
  if (inProgressRuns.length > 0) {
    return { locked: true, heldBy: { kind: 'run', id: inProgressRuns[0].id } };
  }

  const inProgressMaintenance = deps.fileBackupMaintenanceRunsRepo
    .listInProgressByRepository(repositoryId)
    .filter((run) => !isStaleInProgressRun(run));
  if (inProgressMaintenance.length > 0) {
    return { locked: true, heldBy: { kind: 'maintenance', id: inProgressMaintenance[0].id } };
  }

  return { locked: false };
}
