-- The file-backup mirror of 0012's `backup_tasks.windows_task_name`: set only
-- by a successful `file-task:scheduler:install` and cleared only by a
-- successful `file-task:scheduler:uninstall`. Unlike the DB-backup side, the
-- file-backup scheduler name is always id-derived (scheduledTaskNameForId),
-- so this column isn't needed for register/unregister correctness — its sole
-- purpose is the same "is this task's schedule actually registered in
-- Windows?" signal the unified Tareas view shows, without a live elevated
-- schtasks query on every page load.
ALTER TABLE file_backup_tasks ADD COLUMN windows_task_name TEXT;
