import type { BackupTask } from '../types.js';
import type { RunsRepo } from '../db/repositories/runsRepo.js';
import { runBackupTask, type RunBackupTaskDeps, type RunBackupTaskResult } from '../orchestrator/runBackupTask.js';
import { isTaskDue } from './isTaskDue.js';

export interface RunDueResult {
  taskId: string;
  taskName: string;
  ran: boolean; // false if skipped because it wasn't due
  result?: RunBackupTaskResult;
  error?: string;
}

/**
 * Runs every due task in `tasks`, isolating failures per task — a setup
 * error for one task (e.g. a missing client) must never stop the others
 * from being checked and run, mirroring the same isolation the orchestrator
 * already gives individual runs. This is what a Windows Scheduled Task's
 * Action actually invokes (via `engine-cli run-due`), not runBackupTask
 * directly — the due-check has to happen here, before the run.
 */
export async function runDueTasks(
  tasks: BackupTask[],
  deps: RunBackupTaskDeps & { runsRepo: RunsRepo },
  now: Date = new Date()
): Promise<RunDueResult[]> {
  const results: RunDueResult[] = [];
  for (const task of tasks) {
    const latestScheduledRun = deps.runsRepo.getLatestScheduledByTask(task.id);
    if (!isTaskDue(task, now, latestScheduledRun)) {
      results.push({ taskId: task.id, taskName: task.name, ran: false });
      continue;
    }

    try {
      // runDueTasks is the scheduler's own entry point (a Windows Scheduled
      // Task invokes it via `engine-cli run-due`), so every run it starts is
      // 'scheduled' by definition — recorded so isTaskDue can tell it apart
      // from a manual "Ejecutar ahora" the same day.
      const result = await runBackupTask(task, { ...deps, runTrigger: 'scheduled' });
      results.push({ taskId: task.id, taskName: task.name, ran: true, result });
    } catch (err) {
      results.push({
        taskId: task.id,
        taskName: task.name,
        ran: true,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}
