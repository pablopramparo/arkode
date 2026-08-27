-- Tracks the exact Windows Scheduled Task name registered for a task, set
-- only by a successful scheduler:install and cleared only by a successful
-- scheduler:uninstall — this is what makes register/unregister/status safe
-- against the task later being renamed in arkode (the registered name is
-- never recomputed from the live `name` field, only stored once at
-- registration time), and its mere non-NULL-ness is also the only signal
-- this app has for "is this task's schedule actually active in Windows"
-- without needing a live, elevated schtasks query on every page load.
ALTER TABLE backup_tasks ADD COLUMN windows_task_name TEXT;
