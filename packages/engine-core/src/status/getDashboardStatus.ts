import type { ClientsRepo } from '../db/repositories/clientsRepo.js';
import type { TasksRepo } from '../db/repositories/tasksRepo.js';
import type { RunsRepo } from '../db/repositories/runsRepo.js';
import type { BackupSetsRepo } from '../db/repositories/backupSetsRepo.js';
import type { FileBackupTasksRepo } from '../fileBackup/db/repositories/fileBackupTasksRepo.js';
import type { FileBackupRunsRepo } from '../fileBackup/db/repositories/fileBackupRunsRepo.js';
import type { BackupRunStatus, BackupStrategyKind, RunProgress } from '../types.js';
import type { FileBackupSourceKind } from '../fileBackup/types.js';
import { nextScheduledRunAt } from '../scheduler/nextOccurrence.js';

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
  /** Live progress of the latest run, if it's still in progress (and fresh — see RunProgress). Null otherwise. */
  progress: RunProgress | null;
  /** Pure visual/reporting label, or null if unassigned — see BackupSet's own doc comment. */
  backupSetName: string | null;
  /**
   * ISO timestamp of this task's next scheduled run, or null when it has no
   * enabled schedule. A forward projection of the same schedule fields
   * isTaskDue/isFileBackupTaskDue read — see scheduler/nextOccurrence.ts.
   * An overdue-but-not-yet-run task reads null here (it shows under the
   * dashboard's "needs attention", not "upcoming").
   */
  nextRunAt: string | null;
}

export interface GetDashboardStatusDeps {
  clientsRepo: ClientsRepo;
  tasksRepo: TasksRepo;
  runsRepo: RunsRepo;
  backupSetsRepo: BackupSetsRepo;
  fileBackupTasksRepo: FileBackupTasksRepo;
  fileBackupRunsRepo: FileBackupRunsRepo;
}

const IN_PROGRESS: ReadonlySet<string> = new Set(['Running', 'Producing', 'Validating']);

/** Only expose progress for a run that's actually still going — a finished run can leave a stale blob behind. */
function liveProgress(run: { status: string; progress: RunProgress | null } | null): RunProgress | null {
  return run && IN_PROGRESS.has(run.status) ? run.progress : null;
}

function ranToday(startedAt: string | null | undefined, now: Date): boolean {
  if (!startedAt) return false;
  const d = new Date(startedAt);
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

export function getDashboardStatus(deps: GetDashboardStatusDeps, now: Date = new Date()): DashboardRow[] {
  return deps.clientsRepo.listActive().flatMap((client) => {
    const dbRows = deps.tasksRepo
      .listByClient(client.id)
      .filter((task) => task.isActive)
      .map((task): DashboardRow => {
        const latestRun = deps.runsRepo.getLatestByTask(task.id);
        const latestGoodRun = deps.runsRepo.getLatestWithFileByTask(task.id);
        const latestScheduledRun = deps.runsRepo.getLatestScheduledByTask(task.id);
        const backupSet = task.backupSetId ? deps.backupSetsRepo.getById(task.backupSetId) : null;
        const next = nextScheduledRunAt(task, now, ranToday(latestScheduledRun?.startedAt, now));
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
          progress: liveProgress(latestRun),
          backupSetName: backupSet?.name ?? null,
          nextRunAt: next ? next.toISOString() : null,
        };
      });

    const fileRows = deps.fileBackupTasksRepo
      .listByClient(client.id)
      .filter((task) => task.isActive)
      .map((task): DashboardRow => {
        const latestRun = deps.fileBackupRunsRepo.getLatestByTask(task.id);
        const latestGoodRun = deps.fileBackupRunsRepo.getLatestSuccessfulByTask(task.id);
        const backupSet = task.backupSetId ? deps.backupSetsRepo.getById(task.backupSetId) : null;
        // The file-backup scheduler (isFileBackupTaskDue) has no run trigger
        // to distinguish manual vs scheduled, so "ran today" is any run today.
        const next = nextScheduledRunAt(task, now, ranToday(latestRun?.startedAt, now));
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
          progress: liveProgress(latestRun),
          backupSetName: backupSet?.name ?? null,
          nextRunAt: next ? next.toISOString() : null,
        };
      });

    return [...dbRows, ...fileRows];
  });
}
