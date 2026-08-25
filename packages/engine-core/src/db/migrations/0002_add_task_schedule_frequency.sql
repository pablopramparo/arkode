-- Widens backup_tasks' schedule from "a daily HH:MM" to also support weekly
-- (specific days of the week) and monthly (a specific day of the month)
-- schedules. Existing rows default to 'daily', preserving today's behavior
-- exactly. The Windows Scheduled Task's own CalendarTrigger deliberately
-- stays a daily trigger regardless of frequency — isTaskDue() is what
-- actually decides whether a given day matches, the same "OS trigger is
-- just a nudge, the real gate is in code" design already used for the
-- LogonTrigger catch-up path.
ALTER TABLE backup_tasks ADD COLUMN schedule_frequency TEXT NOT NULL DEFAULT 'daily'
  CHECK (schedule_frequency IN ('daily','weekly','monthly'));

-- Comma-separated integers 0 (Sunday) through 6 (Saturday), e.g. "1,3,5".
-- Only meaningful (and required, enforced in tasksRepo.ts) when
-- schedule_frequency = 'weekly'.
ALTER TABLE backup_tasks ADD COLUMN schedule_days_of_week TEXT;

-- 1-31. Only meaningful (and required, enforced in tasksRepo.ts) when
-- schedule_frequency = 'monthly'. A value beyond the current month's length
-- (e.g. 31 in April) clamps to that month's last day — see isTaskDue.ts.
ALTER TABLE backup_tasks ADD COLUMN schedule_day_of_month INTEGER;
