import type { TasksRepo } from '../db/repositories/tasksRepo.js';
import type { RunsRepo } from '../db/repositories/runsRepo.js';
import type { SettingsRepo } from '../db/repositories/settingsRepo.js';
import type { FileBackupTasksRepo } from '../fileBackup/db/repositories/fileBackupTasksRepo.js';
import type { FileBackupRunsRepo } from '../fileBackup/db/repositories/fileBackupRunsRepo.js';
import type { RunBackupTaskDeps } from '../orchestrator/runBackupTask.js';
import type { RunFileBackupTaskDeps } from '../fileBackup/orchestrator/runFileBackupTask.js';
import { runDueTasks } from './runDueTasks.js';
import { runFileBackupDueTasks } from '../fileBackup/scheduler/runFileBackupDueTasks.js';
import { runFileBackupMaintenance, type RunFileBackupMaintenanceDeps } from '../fileBackup/maintenance/runFileBackupMaintenance.js';

/** `app_settings` key the scheduler service stamps every tick — the app reads it to tell "is scheduling actually alive?". */
export const SCHEDULER_HEARTBEAT_KEY = 'schedulerHeartbeatAt';

export interface RunSchedulerTickDeps {
  tasksRepo: TasksRepo;
  fileBackupTasksRepo: FileBackupTasksRepo;
  settingsRepo: SettingsRepo;
  /** Assembled exactly as `run-due` builds it today. */
  dbTaskDeps: RunBackupTaskDeps & { runsRepo: RunsRepo };
  /** Assembled exactly as `file-task:run-due` builds it today. */
  fileTaskDeps: RunFileBackupTaskDeps & { fileBackupRunsRepo: FileBackupRunsRepo };
  /** Assembled exactly as `file-repo:run-maintenance` builds it today. */
  maintenanceDeps: RunFileBackupMaintenanceDeps;
}

interface PhaseSummary {
  ran: number;
  failed: number;
  errors: string[];
}

export interface SchedulerTickResult {
  at: string;
  db: PhaseSummary;
  file: PhaseSummary;
  maintenance: PhaseSummary;
  /** A whole phase threw before its own per-item isolation could catch anything — should be rare. */
  phaseErrors: string[];
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const EMPTY: PhaseSummary = { ran: 0, failed: 0, errors: [] };

/**
 * One scheduler cycle: run every due DB-backup task, every due file-backup
 * task, whatever repository maintenance is due, then stamp the heartbeat.
 *
 * This is what the `arkode-scheduler` Windows service invokes every 60s
 * (via `engine-cli scheduler:tick`). It composes the three existing
 * entry points — `runDueTasks`, `runFileBackupDueTasks`,
 * `runFileBackupMaintenance` — each of which already isolates failures per
 * task/repository; this only adds phase-level isolation (one phase throwing
 * must not stop the next) and the heartbeat write, which happens even if a
 * phase errored — the tick *ran*, and a stale heartbeat is the app's only
 * signal that ticks have stopped entirely.
 */
export async function runSchedulerTick(
  deps: RunSchedulerTickDeps,
  now: Date = new Date()
): Promise<SchedulerTickResult> {
  const phaseErrors: string[] = [];
  let db = EMPTY;
  let file = EMPTY;
  let maintenance = EMPTY;

  try {
    const results = await runDueTasks(deps.tasksRepo.listScheduled(), deps.dbTaskDeps, now);
    db = {
      ran: results.filter((r) => r.ran).length,
      failed: results.filter((r) => r.error || r.result?.run.status === 'Failed').length,
      errors: results.flatMap((r) => (r.error ? [`${r.taskName}: ${r.error}`] : [])),
    };
  } catch (err) {
    phaseErrors.push(`db-backup phase: ${msg(err)}`);
  }

  try {
    const results = await runFileBackupDueTasks(deps.fileBackupTasksRepo.listScheduled(), deps.fileTaskDeps, now);
    file = {
      ran: results.filter((r) => r.ran).length,
      failed: results.filter((r) => r.error || r.result?.run.status === 'Failed').length,
      errors: results.flatMap((r) => (r.error ? [`${r.taskName}: ${r.error}`] : [])),
    };
  } catch (err) {
    phaseErrors.push(`file-backup phase: ${msg(err)}`);
  }

  try {
    const outcomes = await runFileBackupMaintenance(deps.maintenanceDeps, {});
    maintenance = {
      ran: outcomes.filter((o) => o.ran).length,
      failed: outcomes.filter((o) => o.error).length,
      errors: outcomes.flatMap((o) => (o.error ? [`${o.repositoryId}/${o.operation}: ${o.error}`] : [])),
    };
  } catch (err) {
    phaseErrors.push(`maintenance phase: ${msg(err)}`);
  }

  // Always — the tick executed regardless of what any phase did.
  deps.settingsRepo.set(SCHEDULER_HEARTBEAT_KEY, now.toISOString());

  return { at: now.toISOString(), db, file, maintenance, phaseErrors };
}
