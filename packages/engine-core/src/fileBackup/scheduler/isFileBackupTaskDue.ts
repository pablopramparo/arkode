import type { FileBackupRun, FileBackupTask } from '../types.js';

function isSameLocalDate(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function lastDayOfMonth(now: Date): number {
  return new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
}

function matchesDayOfMonth(day: number, now: Date): boolean {
  return now.getDate() === Math.min(day, lastDayOfMonth(now));
}

/**
 * Deliberately duplicated from scheduler/isTaskDue.ts rather than imported
 * or reused via a widened shared type — see this domain's module-level
 * isolation note. Logic is intentionally identical field-for-field (the
 * schema was designed to match), so any behavior change made here should
 * probably be made in isTaskDue.ts too, by hand, not by re-sharing code.
 */
export function isFileBackupTaskDue(task: FileBackupTask, now: Date, latestRun: FileBackupRun | null): boolean {
  if (!task.isActive || !task.scheduleEnabled || !task.scheduleTime) return false;
  if (latestRun && isSameLocalDate(new Date(latestRun.startedAt), now)) return false;

  if (task.scheduleFrequency === 'weekly') {
    if (!task.scheduleDaysOfWeek || !task.scheduleDaysOfWeek.includes(now.getDay())) return false;
  } else if (task.scheduleFrequency === 'monthly') {
    if (task.scheduleDayOfMonth == null || !matchesDayOfMonth(task.scheduleDayOfMonth, now)) return false;
  }

  const [hours, minutes] = task.scheduleTime.split(':').map(Number);
  const scheduledToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes, 0, 0);
  return now.getTime() >= scheduledToday.getTime();
}
