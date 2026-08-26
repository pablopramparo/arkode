-- Adds 'remote_folder' as a second file_backup_tasks.source_kind, alongside
-- the existing local_folder. Neither a plain ADD COLUMN nor a CHECK-widen is
-- possible in place (same SQLite limitation already hit by
-- 0004_add_ftp_transport.sql), so this follows the same documented 12-step
-- "other kinds of schema change" procedure: build the new table, copy every
-- row across unchanged (ids preserved, so file_backup_runs.task_id stays
-- valid with no further changes), drop the old table, rename the new one
-- into place.
--
-- source_path is now nullable: required for local_folder (the real folder
-- to back up), NULL for remote_folder, whose local staging mirror is
-- computed at *run time* (join(client.localBasePath, '_remote-staging',
-- task.id)) rather than stored -- see runFileBackupTask.ts's
-- resolveSourcePath(). transport_id/remote_source_path are the reverse:
-- NULL for local_folder, required for remote_folder. transport_id reuses
-- the existing transports table -- no new transport concept.
PRAGMA foreign_keys=OFF;

CREATE TABLE file_backup_tasks_new (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL REFERENCES file_backup_repositories(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('local_folder','remote_folder')),
  source_path TEXT,
  transport_id TEXT REFERENCES transports(id) ON DELETE CASCADE,
  remote_source_path TEXT,
  retention_count INTEGER,
  retention_days INTEGER,
  schedule_time TEXT,
  schedule_enabled INTEGER NOT NULL DEFAULT 1 CHECK (schedule_enabled IN (0,1)),
  schedule_frequency TEXT NOT NULL DEFAULT 'daily' CHECK (schedule_frequency IN ('daily','weekly','monthly')),
  schedule_days_of_week TEXT,
  schedule_day_of_month INTEGER,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (
    (source_kind = 'local_folder' AND source_path IS NOT NULL AND transport_id IS NULL AND remote_source_path IS NULL)
    OR
    (source_kind = 'remote_folder' AND source_path IS NULL AND transport_id IS NOT NULL AND remote_source_path IS NOT NULL)
  )
);

INSERT INTO file_backup_tasks_new
  (id, client_id, repository_id, name, source_kind, source_path, transport_id, remote_source_path,
   retention_count, retention_days, schedule_time, schedule_enabled, schedule_frequency,
   schedule_days_of_week, schedule_day_of_month, is_active, created_at, updated_at)
SELECT
  id, client_id, repository_id, name, source_kind, source_path, NULL, NULL,
  retention_count, retention_days, schedule_time, schedule_enabled, schedule_frequency,
  schedule_days_of_week, schedule_day_of_month, is_active, created_at, updated_at
FROM file_backup_tasks;

DROP TABLE file_backup_tasks;
ALTER TABLE file_backup_tasks_new RENAME TO file_backup_tasks;

PRAGMA foreign_keys=ON;
