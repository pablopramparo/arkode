import type { ScheduleFrequency } from '../types.js';

/**
 * The subset of schedule fields both `backup_tasks` and `file_backup_tasks`
 * carry, with identical names/semantics (the schema was designed to match —
 * see isFileBackupTaskDue.ts's note). This is the one place that projects a
 * schedule FORWARD to its next run; `isTaskDue` / `isFileBackupTaskDue`
 * decide "is it due right now" — same field interpretation, opposite
 * direction. If the day/time interpretation changes in those, change it
 * here too (by hand — the file-backup domain deliberately doesn't share
 * scheduler code).
 */
export interface ScheduleShape {
  scheduleEnabled: boolean;
  scheduleTime: string | null;
  scheduleFrequency: ScheduleFrequency;
  scheduleDaysOfWeek: number[] | null;
  scheduleDayOfMonth: number | null;
}

function lastDayOfMonth(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
}

/** Same clamping rule as isTaskDue: "on the 31st" means "last day" for short months. */
function matchesDayOfMonth(day: number, d: Date): boolean {
  return d.getDate() === Math.min(day, lastDayOfMonth(d));
}

function dayMatchesFrequency(schedule: ScheduleShape, d: Date): boolean {
  if (schedule.scheduleFrequency === 'weekly') {
    return !!schedule.scheduleDaysOfWeek && schedule.scheduleDaysOfWeek.includes(d.getDay());
  }
  if (schedule.scheduleFrequency === 'monthly') {
    return schedule.scheduleDayOfMonth != null && matchesDayOfMonth(schedule.scheduleDayOfMonth, d);
  }
  return true; // daily
}

/**
 * The next moment this schedule will fire strictly after `now`, or null if
 * it never will (disabled, no time, weekly with no days, monthly with no
 * day). `alreadyRanToday` mirrors `isTaskDue`'s `latestScheduledRun` guard:
 * when today is an eligible day and its slot hasn't passed and it hasn't
 * run yet today, the answer is today's slot; once today's slot is behind us
 * (or it already ran today) the answer rolls to the next eligible day.
 * An overdue-but-not-yet-run task is intentionally NOT surfaced here — that
 * belongs in the dashboard's "needs attention" list, not "upcoming".
 */
export function nextScheduledRunAt(schedule: ScheduleShape, now: Date, alreadyRanToday: boolean): Date | null {
  if (!schedule.scheduleEnabled || !schedule.scheduleTime) return null;
  const [hours, minutes] = schedule.scheduleTime.split(':').map(Number);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  if (schedule.scheduleFrequency === 'weekly' && (!schedule.scheduleDaysOfWeek || schedule.scheduleDaysOfWeek.length === 0)) {
    return null;
  }
  if (schedule.scheduleFrequency === 'monthly' && schedule.scheduleDayOfMonth == null) return null;

  // Walk day by day from today; 400 days is well past any monthly edge case.
  for (let offset = 0; offset < 400; offset++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, hours, minutes, 0, 0);
    if (!dayMatchesFrequency(schedule, day)) continue;
    if (offset === 0) {
      if (alreadyRanToday) continue;
      if (day.getTime() <= now.getTime()) continue; // today's slot already passed
    }
    return day;
  }
  return null;
}
