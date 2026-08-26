import { unlink } from 'node:fs/promises';
import type { RunsRepo } from '../db/repositories/runsRepo.js';
import type { RetentionDeletionsRepo } from '../db/repositories/retentionDeletionsRepo.js';

const IN_PROGRESS_STATUSES = ['Running', 'Producing', 'Validating'];

export interface DeleteBackupRunDeps {
  runsRepo: RunsRepo;
  retentionDeletionsRepo: RetentionDeletionsRepo;
}

/**
 * Deletes one specific backup on explicit human request — distinct from
 * applyRetention.ts's automated pass, which this deliberately mirrors the
 * file-deletion mechanics of (unlink, swallow ENOENT, record via the same
 * retention_deletions table with reason: 'manual_delete' — no schema change
 * needed, that column has never had a CHECK restricting its values).
 *
 * Deliberately does NOT enforce retention's "never delete the newest /
 * never leave zero" guardrails — those protect *automated* retention from
 * misconfiguration, not a human deliberately picking one backup to remove;
 * the UI's own confirmation dialog is the actual safeguard here. Also
 * deliberately does not touch the backup_runs row itself (status/local_path
 * stay as recorded), matching automated retention's own behavior exactly —
 * downstream code (e.g. the download endpoint) already treats a missing
 * file on disk as the real signal, not the DB column.
 */
export async function deleteBackupRun(runId: string, deps: DeleteBackupRunDeps): Promise<{ deleted: boolean }> {
  const run = deps.runsRepo.getById(runId);
  if (!run) throw new Error(`Run ${runId} not found.`);
  if (IN_PROGRESS_STATUSES.includes(run.status)) throw new Error(`Run ${runId} is still in progress and can't be deleted.`);
  if (!run.localPath) throw new Error(`Run ${runId} has no local file to delete.`);

  try {
    await unlink(run.localPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    // Already gone — still record it, since the file is in fact absent now.
  }

  deps.retentionDeletionsRepo.create({
    taskId: run.taskId,
    deletedBackupRunId: run.id,
    triggeredByRunId: null,
    localPath: run.localPath,
    sizeBytes: run.sizeBytes,
    reason: 'manual_delete',
  });

  return { deleted: true };
}
