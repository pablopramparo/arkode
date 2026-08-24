import { unlink } from 'node:fs/promises';
import type { BackupRun, BackupTask, Client } from '../types.js';
import type { RunsRepo } from '../db/repositories/runsRepo.js';
import type { RetentionDeletionsRepo } from '../db/repositories/retentionDeletionsRepo.js';
import type { RunLogger } from '../logging/logger.js';

export interface RetentionPolicy {
  count: number | null;
  days: number | null;
}

/** Task-level policy overrides the client-level default; neither set means "no retention." */
export function resolveRetentionPolicy(client: Client, task: BackupTask): RetentionPolicy {
  return {
    count: task.retentionCount ?? client.retentionCount ?? null,
    days: task.retentionDays ?? client.retentionDays ?? null,
  };
}

export interface ApplyRetentionDeps {
  runsRepo: RunsRepo;
  retentionDeletionsRepo: RetentionDeletionsRepo;
  logger: RunLogger;
  /** The run whose completion triggered this retention pass, for the deletion record's audit trail. */
  triggeredByRunId: string | null;
}

/**
 * Deletes old Success backups per the resolved policy. Two hard invariants
 * hold regardless of how aggressive the configured policy is:
 *  - a run is only ever a delete candidate if a *later Success run* exists
 *    (guaranteed here by never touching the newest Success run);
 *  - at least one Success run always survives, even if the policy would
 *    otherwise remove every one.
 * Warning/Failed runs are never touched by retention — only Success runs
 * are considered "valid" backups for this purpose.
 */
export async function applyRetention(task: BackupTask, policy: RetentionPolicy, deps: ApplyRetentionDeps): Promise<void> {
  if (policy.count == null && policy.days == null) return;

  // A run already recorded as deleted no longer occupies a "kept backup"
  // slot — excluding it here (rather than only checking before unlink)
  // keeps both the rank/day evaluation and the survivor-floor check below
  // based on backups that actually still exist on disk, and is what stops
  // an old, already-pruned run from being re-evaluated (and re-recorded)
  // on every subsequent retention pass forever.
  const alreadyDeleted = deps.retentionDeletionsRepo.listDeletedRunIds(task.id);
  const successfulRuns = deps.runsRepo.listSuccessfulRuns(task.id).filter((run) => !alreadyDeleted.has(run.id)); // newest first
  if (successfulRuns.length <= 1) return;

  const cutoffMs = policy.days != null ? Date.now() - policy.days * 24 * 60 * 60 * 1000 : null;

  function violatesCount(rank: number): boolean {
    return policy.count != null && rank >= policy.count;
  }

  function violatesDays(run: BackupRun): boolean {
    if (cutoffMs == null) return false;
    // downloaded_at is the authoritative "age" field (locally generated,
    // always trustworthy) — never remote_modified_at, which can reflect
    // when a file was produced/copied remotely rather than downloaded here,
    // and is subject to clock skew between this PC and the remote host.
    const ageSource = run.downloadedAt ?? run.startedAt;
    return new Date(ageSource).getTime() < cutoffMs;
  }

  const candidates: Array<{ run: BackupRun; reason: string }> = [];
  successfulRuns.forEach((run, rank) => {
    if (rank === 0) return; // never touch the newest Success run

    const countViolation = violatesCount(rank);
    const daysViolation = violatesDays(run);

    let shouldDelete: boolean;
    let reason: string;
    if (policy.count != null && policy.days != null) {
      // Both configured: require both to agree a run is stale, so combining
      // the two policies is never more aggressive than either alone.
      shouldDelete = countViolation && daysViolation;
      reason = 'retention_count_and_days_exceeded';
    } else if (policy.count != null) {
      shouldDelete = countViolation;
      reason = 'retention_count_exceeded';
    } else {
      shouldDelete = daysViolation;
      reason = 'retention_days_exceeded';
    }

    if (shouldDelete) candidates.push({ run, reason });
  });

  // Hard floor: never let deletions bring the surviving count below 1.
  // Oldest-first if this cap is ever actually hit (candidates are currently
  // ordered newest-of-the-candidates first, since successfulRuns is
  // newest-first overall).
  const maxDeletable = successfulRuns.length - 1;
  const toDelete = [...candidates].reverse().slice(0, maxDeletable);

  for (const { run, reason } of toDelete) {
    if (!run.localPath) continue; // defensive — a Success run should always have one

    try {
      await unlink(run.localPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        deps.logger.log(
          'warn',
          'retention',
          `Failed to delete ${run.localPath}: ${err instanceof Error ? err.message : String(err)}`
        );
        continue; // don't record a deletion that didn't actually happen
      }
      // Already gone (ENOENT) — still record it, since the file is in fact absent now.
    }

    deps.retentionDeletionsRepo.create({
      taskId: task.id,
      deletedBackupRunId: run.id,
      triggeredByRunId: deps.triggeredByRunId,
      localPath: run.localPath,
      sizeBytes: run.sizeBytes,
      reason,
    });
    deps.logger.log('info', 'retention', `Deleted old backup ${run.localPath} (${reason}).`);
  }
}
