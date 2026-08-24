import type { BackupRun, BackupTask } from '../types.js';

function isSameLocalDate(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/**
 * A task is due when it has an enabled schedule, has had NO attempt at all
 * (Success, Warning, or Failed) yet today, and the current time is at or
 * after today's scheduled time.
 *
 * The "no attempt yet today" check is what makes it safe for a task's own
 * Windows Scheduled Task to carry both a CalendarTrigger (fires exactly at
 * schedule_time) and a LogonTrigger (catches up a run missed because the PC
 * was off) — without it, a PC that never went offline would still get a
 * second, redundant run whenever the LogonTrigger also happened to fire
 * that same day (e.g. an unrelated reboot).
 */
export function isTaskDue(task: BackupTask, now: Date, latestRun: BackupRun | null): boolean {
  if (!task.isActive || !task.scheduleEnabled || !task.scheduleTime) return false;
  if (latestRun && isSameLocalDate(new Date(latestRun.startedAt), now)) return false;

  const [hours, minutes] = task.scheduleTime.split(':').map(Number);
  const scheduledToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes, 0, 0);
  return now.getTime() >= scheduledToday.getTime();
}
