import type { FileBackupTask } from '../types.js';
import type { FileBackupRunsRepo } from '../db/repositories/fileBackupRunsRepo.js';
import { runFileBackupTask, type RunFileBackupTaskDeps, type RunFileBackupTaskResult } from '../orchestrator/runFileBackupTask.js';
import { isFileBackupTaskDue } from './isFileBackupTaskDue.js';

export interface FileBackupRunDueResult {
  taskId: string;
  taskName: string;
  ran: boolean;
  result?: RunFileBackupTaskResult;
  error?: string;
}

/**
 * Deliberately duplicated from scheduler/runDueTasks.ts rather than shared —
 * same isolation note as the rest of this domain. Runs every due task in
 * `tasks`, isolating failures per task, mirroring the DB-backup path's
 * "one client's failure must never stop the others" principle.
 */
export async function runFileBackupDueTasks(
  tasks: FileBackupTask[],
  deps: RunFileBackupTaskDeps & { fileBackupRunsRepo: FileBackupRunsRepo },
  now: Date = new Date()
): Promise<FileBackupRunDueResult[]> {
  const results: FileBackupRunDueResult[] = [];
  for (const task of tasks) {
    const latestRun = deps.fileBackupRunsRepo.getLatestByTask(task.id);
    if (!isFileBackupTaskDue(task, now, latestRun)) {
      results.push({ taskId: task.id, taskName: task.name, ran: false });
      continue;
    }

    try {
      const result = await runFileBackupTask(task, deps);
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
