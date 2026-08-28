import type { BackupRun, BackupTask } from '../types.js';

function isSameLocalDate(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function lastDayOfMonth(now: Date): number {
  return new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
}

/**
 * A configured day-of-month beyond the current month's length (e.g. 31 in
 * April) clamps to that month's last day, so "on the 31st" reads naturally
 * as "on the last day" for short months instead of silently never firing.
 */
function matchesDayOfMonth(day: number, now: Date): boolean {
  return now.getDate() === Math.min(day, lastDayOfMonth(now));
}

/**
 * A task is due when it has an enabled schedule, today matches its
 * configured frequency (every day for 'daily'; one of scheduleDaysOfWeek
 * for 'weekly'; scheduleDayOfMonth — clamped — for 'monthly'), NO
 * *scheduled* attempt (Success, Warning, or Failed) has happened yet today,
 * and the current time is at or after today's scheduled time.
 *
 * `latestScheduledRun` is deliberately the newest run with trigger =
 * 'scheduled' only — a manual "Ejecutar ahora" during the day is ignored
 * here, so it never suppresses that day's scheduled run. (Earlier this was
 * "no attempt of ANY kind today", which meant a manual morning run
 * silently cancelled the night's scheduled backup — a real production
 * surprise.)
 *
 * The "no scheduled attempt yet today" check is what makes it safe for a
 * task's own Windows Scheduled Task to carry both a CalendarTrigger (fires
 * exactly at schedule_time, every day regardless of frequency) and a
 * LogonTrigger (catches up a run missed because the PC was off) — without
 * it, a PC that never went offline would still get a second, redundant run
 * whenever the LogonTrigger also happened to fire that same day (e.g. an
 * unrelated reboot). The CalendarTrigger firing daily even for
 * weekly/monthly tasks is deliberate too: it's just a nudge to check, and
 * this function's frequency match is the only thing that actually gates a
 * run.
 */
export function isTaskDue(task: BackupTask, now: Date, latestScheduledRun: BackupRun | null): boolean {
  if (!task.isActive || !task.scheduleEnabled || !task.scheduleTime) return false;
  if (latestScheduledRun && isSameLocalDate(new Date(latestScheduledRun.startedAt), now)) return false;

  if (task.scheduleFrequency === 'weekly') {
    if (!task.scheduleDaysOfWeek || !task.scheduleDaysOfWeek.includes(now.getDay())) return false;
  } else if (task.scheduleFrequency === 'monthly') {
    if (task.scheduleDayOfMonth == null || !matchesDayOfMonth(task.scheduleDayOfMonth, now)) return false;
  }

  const [hours, minutes] = task.scheduleTime.split(':').map(Number);
  const scheduledToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes, 0, 0);
  return now.getTime() >= scheduledToday.getTime();
}
