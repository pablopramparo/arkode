import type { ClientsRepo } from '../db/repositories/clientsRepo.js';
import type { TasksRepo } from '../db/repositories/tasksRepo.js';
import type { RunsRepo } from '../db/repositories/runsRepo.js';
import type { BackupRunStatus, BackupStrategyKind } from '../types.js';

export interface DashboardRow {
  clientId: string;
  client: string;
  taskId: string;
  task: string;
  strategy: BackupStrategyKind;
  /** Reflects the latest attempt, whatever it was — a fresh Failed run must show up immediately, never be hidden behind an old good backup. */
  status: BackupRunStatus | 'NeverRun';
  /**
   * Size/checksum/lastGoodBackupAt come from the latest run that actually
   * has a file on disk (Success or Warning) — NOT from the latest attempt,
   * which could be a no-op or a Failed run with no file at all. This is
   * what lets the dashboard answer "how stale is my actual protection?"
   * independently of "did the last attempt succeed?".
   */
  sizeBytes: number | null;
  checksumSha256: string | null;
  lastGoodBackupAt: string | null;
  /** When the latest attempt (regardless of outcome) finished, for "last checked". */
  latestAttemptAt: string | null;
  /** The latest attempt's error message, if it failed — null otherwise (including for a never-run task). */
  latestErrorMessage: string | null;
}

export interface GetDashboardStatusDeps {
  clientsRepo: ClientsRepo;
  tasksRepo: TasksRepo;
  runsRepo: RunsRepo;
}

export function getDashboardStatus(deps: GetDashboardStatusDeps): DashboardRow[] {
  return deps.clientsRepo.listActive().flatMap((client) =>
    deps.tasksRepo.listByClient(client.id).map((task): DashboardRow => {
      const latestRun = deps.runsRepo.getLatestByTask(task.id);
      const latestGoodRun = deps.runsRepo.getLatestWithFileByTask(task.id);
      return {
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
      };
    })
  );
}
