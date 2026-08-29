import type { ClientsRepo } from '../db/repositories/clientsRepo.js';
import type { TasksRepo } from '../db/repositories/tasksRepo.js';
import type { RunsRepo } from '../db/repositories/runsRepo.js';
import type { BackupSetsRepo } from '../db/repositories/backupSetsRepo.js';
import type { FileBackupTasksRepo } from '../fileBackup/db/repositories/fileBackupTasksRepo.js';
import type { FileBackupRunsRepo } from '../fileBackup/db/repositories/fileBackupRunsRepo.js';
import type { BackupRunStatus, BackupStrategyKind } from '../types.js';
import type { FileBackupSourceKind } from '../fileBackup/types.js';

export interface DashboardRow {
  /**
   * Which backup domain this row comes from — DB-dump tasks (`backup_tasks`)
   * or restic-backed file tasks (`file_backup_tasks`). Both share the same
   * "does this client have a recent, valid backup?" dashboard.
   */
  kind: 'db' | 'file';
  clientId: string;
  client: string;
  taskId: string;
  task: string;
  /** DB tasks: the dump strategy. File tasks: the folder source kind. */
  strategy: BackupStrategyKind | FileBackupSourceKind;
  /** Reflects the latest attempt, whatever it was — a fresh Failed run must show up immediately, never be hidden behind an old good backup. */
  status: BackupRunStatus | 'NeverRun';
  /**
   * Size/checksum/lastGoodBackupAt come from the latest run that actually
   * has a file on disk (Success or Warning) — NOT from the latest attempt,
   * which could be a no-op or a Failed run with no file at all. This is
   * what lets the dashboard answer "how stale is my actual protection?"
   * independently of "did the last attempt succeed?".
   *
   * For file tasks `sizeBytes` is restic's `totalBytesProcessed` for that
   * run (the protected footprint, not the deduped "data added"), and
   * `checksumSha256` is always null (a restic snapshot has no single hash).
   */
  sizeBytes: number | null;
  checksumSha256: string | null;
  lastGoodBackupAt: string | null;
  /** When the latest attempt (regardless of outcome) finished, for "last checked". */
  latestAttemptAt: string | null;
  /** The latest attempt's error message, if it failed — null otherwise (including for a never-run task). */
  latestErrorMessage: string | null;
  /** Pure visual/reporting label, or null if unassigned — see BackupSet's own doc comment. */
  backupSetName: string | null;
}

export interface GetDashboardStatusDeps {
  clientsRepo: ClientsRepo;
  tasksRepo: TasksRepo;
  runsRepo: RunsRepo;
  backupSetsRepo: BackupSetsRepo;
  fileBackupTasksRepo: FileBackupTasksRepo;
  fileBackupRunsRepo: FileBackupRunsRepo;
}

export function getDashboardStatus(deps: GetDashboardStatusDeps): DashboardRow[] {
  return deps.clientsRepo.listActive().flatMap((client) => {
    const dbRows = deps.tasksRepo
      .listByClient(client.id)
      .filter((task) => task.isActive)
      .map((task): DashboardRow => {
        const latestRun = deps.runsRepo.getLatestByTask(task.id);
        const latestGoodRun = deps.runsRepo.getLatestWithFileByTask(task.id);
        const backupSet = task.backupSetId ? deps.backupSetsRepo.getById(task.backupSetId) : null;
        return {
          kind: 'db',
          clientId: client.id,
          client: client.name,
          taskId: task.id,
          task: task.name,
          strategy: task.strategy,
          status: latestRun?.status ?? 'NeverRun',
          sizeBytes: latestGoodRun?.sizeBytes ?? null,
          checksumSha256: latestGoodRun?.checksumSha256 ?? null,
          lastGoodBackupAt: latestGoodRun?.downloadedAt ?? null,
          latestAttemptAt: latestRun?.finishedAt ?? null,
          latestErrorMessage: latestRun?.errorMessage ?? null,
          backupSetName: backupSet?.name ?? null,
        };
      });

    const fileRows = deps.fileBackupTasksRepo
      .listByClient(client.id)
      .filter((task) => task.isActive)
      .map((task): DashboardRow => {
        const latestRun = deps.fileBackupRunsRepo.getLatestByTask(task.id);
        const latestGoodRun = deps.fileBackupRunsRepo.getLatestSuccessfulByTask(task.id);
        const backupSet = task.backupSetId ? deps.backupSetsRepo.getById(task.backupSetId) : null;
        return {
          kind: 'file',
          clientId: client.id,
          client: client.name,
          taskId: task.id,
          task: task.name,
          strategy: task.sourceKind,
          status: latestRun?.status ?? 'NeverRun',
          sizeBytes: latestGoodRun?.totalBytesProcessed ?? null,
          checksumSha256: null,
          lastGoodBackupAt: latestGoodRun?.finishedAt ?? null,
          latestAttemptAt: latestRun?.finishedAt ?? null,
          latestErrorMessage: latestRun?.errorMessage ?? null,
          backupSetName: backupSet?.name ?? null,
        };
      });

    return [...dbRows, ...fileRows];
  });
}
