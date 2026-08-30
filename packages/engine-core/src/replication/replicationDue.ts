import type { RunsRepo } from '../db/repositories/runsRepo.js';
import type { FileBackupRunsRepo } from '../fileBackup/db/repositories/fileBackupRunsRepo.js';
import type { ReplicationTarget } from './types.js';

/**
 * "Is this target due for a sync right now?" — derived entirely from
 * existing backup-run rows, so the backup orchestrators need no write hook
 * and there is no `dirty` flag to keep consistent.
 *
 * Due when the target is enabled AND any of:
 *   - it has never replicated;
 *   - its last replication failed (retry, but no more often than the floor);
 *   - a successful backup for its client finished after its last replication
 *     (again, subject to the floor).
 */
export interface ReplicationDueDeps {
  runsRepo: Pick<RunsRepo, 'listRecent'>;
  fileBackupRunsRepo: Pick<FileBackupRunsRepo, 'listRecent'>;
}

export interface IsReplicationDueOptions {
  now?: Date;
  /** Don't re-sync within this window of the last attempt (except after a failure, same floor). */
  minIntervalMs?: number;
}

const DEFAULT_MIN_INTERVAL_MS = 5 * 60 * 1000;

export function isReplicationDue(
  target: ReplicationTarget,
  deps: ReplicationDueDeps,
  opts: IsReplicationDueOptions = {}
): boolean {
  if (!target.enabled) return false;

  const nowMs = (opts.now ?? new Date()).getTime();
  const minInterval = opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;

  if (!target.lastReplicatedAt) return true;

  const lastMs = Date.parse(target.lastReplicatedAt);
  const sinceLast = nowMs - (Number.isNaN(lastMs) ? 0 : lastMs);

  if (target.lastStatus === 'Failed') return sinceLast >= minInterval;

  const latestBackupAt = latestSuccessfulBackupAt(target, deps);
  if (!latestBackupAt) return false;
  const backupMs = Date.parse(latestBackupAt);
  if (Number.isNaN(backupMs) || backupMs <= lastMs) return false;

  return sinceLast >= minInterval;
}

export function listDueReplications(
  targets: ReplicationTarget[],
  deps: ReplicationDueDeps,
  opts: IsReplicationDueOptions = {}
): ReplicationTarget[] {
  return targets.filter((t) => isReplicationDue(t, deps, opts));
}

function latestSuccessfulBackupAt(target: ReplicationTarget, deps: ReplicationDueDeps): string | null {
  const rows =
    target.content === 'restic_repo'
      ? deps.fileBackupRunsRepo.listRecent({ clientId: target.clientId, limit: 50 })
      : deps.runsRepo.listRecent({ clientId: target.clientId, limit: 50 });
  for (const r of rows) {
    if ((r.status === 'Success' || r.status === 'Warning') && r.finishedAt) return r.finishedAt;
  }
  return null;
}
