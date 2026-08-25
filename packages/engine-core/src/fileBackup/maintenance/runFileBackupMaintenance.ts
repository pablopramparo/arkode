import type { SecretStore } from '../../secrets/types.js';
import type { FileBackupMaintenanceOperation, FileBackupRepository } from '../types.js';
import type { FileBackupRepositoriesRepo } from '../db/repositories/fileBackupRepositoriesRepo.js';
import type { FileBackupMaintenanceRunsRepo } from '../db/repositories/fileBackupMaintenanceRunsRepo.js';
import type { FileBackupRunsRepo } from '../db/repositories/fileBackupRunsRepo.js';
import { checkRepositoryLock, recoverStaleRepositoryRuns } from '../locking/repositoryLock.js';
import * as resticClient from '../restic/resticClient.js';

export interface RunFileBackupMaintenanceDeps {
  fileBackupRepositoriesRepo: FileBackupRepositoriesRepo;
  fileBackupMaintenanceRunsRepo: FileBackupMaintenanceRunsRepo;
  fileBackupRunsRepo: FileBackupRunsRepo;
  secretStore: SecretStore;
}

export interface RunFileBackupMaintenanceOpts {
  /** One specific repository; omit to sweep every repository belonging to an active client. */
  repositoryId?: string;
  /** One specific operation, run regardless of its own due-cadence; omit to run whatever is due (prune/check only — check_read_data is never auto-scheduled, see below). */
  operation?: FileBackupMaintenanceOperation | 'all';
}

export interface FileBackupMaintenanceOutcome {
  repositoryId: string;
  operation: FileBackupMaintenanceOperation;
  ran: boolean;
  skippedReason?: string;
  error?: string;
}

// Hardcoded for this first increment rather than user-configurable — not
// worth a settings UI for a need nobody has expressed yet. Revisit if it
// ever needs to vary per client/repository.
const PRUNE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;

// Per the user's explicit instruction for this first increment. Verified in
// the PoC that restic's *default* --max-unused (5%) leaves real orphaned
// space behind, and --max-unused 0 forces a full reclaim — flagged here,
// as instructed, as something that can get expensive on large repositories
// and may need a less aggressive default later.
const PRUNE_MAX_UNUSED = '0';

function isDue(lastRunAt: string | null, intervalMs: number): boolean {
  if (!lastRunAt) return true;
  return Date.now() - new Date(lastRunAt).getTime() >= intervalMs;
}

/**
 * Not part of the per-task orchestrator — prune/check are repository-scoped
 * maintenance with their own cadence, deliberately never run as a side
 * effect of a normal backup (see runFileBackupTask.ts / the plan's design
 * notes). Intended to be invoked by one global Windows Scheduled Task
 * (`\arkode\file-backup-maintenance`) with no arguments, sweeping every
 * repository and running whatever is due — or manually, via the CLI/UI,
 * targeting one repository and/or forcing a specific operation regardless
 * of cadence.
 *
 * `check_read_data` is never included in the automatic "whatever is due"
 * sweep — its cost at real production repository sizes wasn't verified in
 * the PoC (only at ~390MB), so it stays a manual/CLI-only action for now.
 */
export async function runFileBackupMaintenance(
  deps: RunFileBackupMaintenanceDeps,
  opts: RunFileBackupMaintenanceOpts = {}
): Promise<FileBackupMaintenanceOutcome[]> {
  const repositories: FileBackupRepository[] = opts.repositoryId
    ? [deps.fileBackupRepositoriesRepo.getById(opts.repositoryId)].filter((r): r is FileBackupRepository => r != null)
    : deps.fileBackupRepositoriesRepo.listForActiveClients();

  const outcomes: FileBackupMaintenanceOutcome[] = [];
  const lockDeps = { fileBackupRunsRepo: deps.fileBackupRunsRepo, fileBackupMaintenanceRunsRepo: deps.fileBackupMaintenanceRunsRepo };

  for (const repository of repositories) {
    recoverStaleRepositoryRuns(lockDeps, repository.id);

    const operationsToConsider: FileBackupMaintenanceOperation[] =
      !opts.operation || opts.operation === 'all' ? ['prune', 'check'] : [opts.operation];

    for (const operation of operationsToConsider) {
      // A manually-requested single operation always runs regardless of
      // cadence; an automatic sweep (opts.operation omitted/'all') respects
      // each operation's own due interval.
      const forced = opts.operation != null && opts.operation !== 'all';
      const due =
        forced ||
        (operation === 'prune' ? isDue(repository.lastPrunedAt, PRUNE_INTERVAL_MS) : isDue(repository.lastCheckedAt, CHECK_INTERVAL_MS));

      if (!due) {
        outcomes.push({ repositoryId: repository.id, operation, ran: false, skippedReason: 'not due yet' });
        continue;
      }

      const lock = checkRepositoryLock(lockDeps, repository.id, operation);
      if (lock.locked) {
        outcomes.push({ repositoryId: repository.id, operation, ran: false, skippedReason: 'repository busy' });
        continue;
      }

      const password = deps.secretStore.get(repository.passwordSecretRef);
      if (!password) {
        outcomes.push({ repositoryId: repository.id, operation, ran: false, error: 'Could not resolve the repository password.' });
        continue;
      }

      const maintenanceRun = deps.fileBackupMaintenanceRunsRepo.create({ repositoryId: repository.id, operation, pid: process.pid });
      try {
        if (operation === 'prune') {
          const { bytesReclaimed } = await resticClient.prune(repository.repoPath, password, { maxUnused: PRUNE_MAX_UNUSED });
          deps.fileBackupMaintenanceRunsRepo.markFinished(maintenanceRun.id, 'Success', { bytesReclaimed });
          deps.fileBackupRepositoriesRepo.markPruned(repository.id);
        } else {
          const result = await resticClient.check(repository.repoPath, password, { readData: operation === 'check_read_data' });
          deps.fileBackupMaintenanceRunsRepo.markFinished(maintenanceRun.id, result.ok ? 'Success' : 'Warning', {
            errorMessage: result.message,
          });
          deps.fileBackupRepositoriesRepo.markChecked(repository.id);
        }
        outcomes.push({ repositoryId: repository.id, operation, ran: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        deps.fileBackupMaintenanceRunsRepo.markFinished(maintenanceRun.id, 'Failed', { errorMessage: message });
        outcomes.push({ repositoryId: repository.id, operation, ran: true, error: message });
      }
    }
  }

  return outcomes;
}
