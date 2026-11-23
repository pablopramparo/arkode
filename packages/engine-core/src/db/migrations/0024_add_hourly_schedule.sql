-- Adds the 'hourly' ("cada N horas") schedule frequency plus its
-- schedule_interval_hours column, for BOTH backup_tasks and
-- file_backup_tasks. schedule_frequency carries a CHECK ('daily','weekly',
-- 'monthly') that SQLite can't widen in place, so both tables are rebuilt with
-- the same 12-step procedure as 0004/0007/0008/0011 (ids preserved, so every
-- FK pointing at them stays valid). Existing rows keep their frequency and get
-- schedule_interval_hours = NULL — no behavior change for any current task.
--
-- Also adds file_backup_runs.trigger ('manual' | 'scheduled', existing rows
-- 'manual'), mirroring 0013 for backup_runs, so the hourly due-check can tell
-- a scheduled run from a manual "Ejecutar ahora" in the file domain too.
-- (daily/weekly/monthly file tasks keep their existing "any run today" check.)
PRAGMA foreign_keys=OFF;

CREATE TABLE backup_tasks_new (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  strategy TEXT NOT NULL CHECK (strategy IN ('fetch_existing','remote_dump','direct_dump')),
  transport_id TEXT REFERENCES transports(id) ON DELETE CASCADE,
  database_connection_id TEXT REFERENCES database_connections(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  db_engine TEXT NOT NULL CHECK (db_engine IN ('postgres','mysql','mariadb','unknown')),
  remote_path TEXT,
  remote_file_pattern TEXT,
  remote_command TEXT,
  remote_output_path_template TEXT,
  remote_cleanup INTEGER NOT NULL DEFAULT 0 CHECK (remote_cleanup IN (0,1)),
  remote_dump_exec_mode TEXT NOT NULL DEFAULT 'host' CHECK (remote_dump_exec_mode IN ('host','docker')),
  docker_container TEXT,
  remote_dump_database TEXT,
  remote_dump_db_user TEXT,
  remote_dump_db_password_secret_ref TEXT,
  schedule_time TEXT,
  schedule_enabled INTEGER NOT NULL DEFAULT 1 CHECK (schedule_enabled IN (0,1)),
  retention_count INTEGER,
  retention_days INTEGER,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  schedule_frequency TEXT NOT NULL DEFAULT 'daily' CHECK (schedule_frequency IN ('daily','weekly','monthly','hourly')),
  schedule_days_of_week TEXT,
  schedule_day_of_month INTEGER,
  backup_set_id TEXT REFERENCES backup_sets(id) ON DELETE SET NULL,
  windows_task_name TEXT,
  schedule_interval_hours INTEGER,
  CHECK (
    (strategy = 'fetch_existing' AND transport_id IS NOT NULL AND database_connection_id IS NULL
       AND remote_path IS NOT NULL AND remote_command IS NULL AND remote_output_path_template IS NULL)
    OR
    (strategy = 'remote_dump' AND transport_id IS NOT NULL AND database_connection_id IS NULL AND remote_path IS NULL
       AND remote_output_path_template IS NOT NULL
       AND (
         (remote_dump_exec_mode = 'host' AND remote_command IS NOT NULL)
         OR
         (remote_dump_exec_mode = 'docker' AND docker_container IS NOT NULL AND remote_dump_database IS NOT NULL AND remote_dump_db_user IS NOT NULL)
       ))
    OR
    (strategy = 'direct_dump' AND database_connection_id IS NOT NULL AND transport_id IS NULL
       AND remote_path IS NULL AND remote_command IS NULL AND remote_output_path_template IS NULL)
  )
);

INSERT INTO backup_tasks_new
  (id, client_id, strategy, transport_id, database_connection_id, name, db_engine,
   remote_path, remote_file_pattern, remote_command, remote_output_path_template, remote_cleanup,
   remote_dump_exec_mode, docker_container, remote_dump_database, remote_dump_db_user, remote_dump_db_password_secret_ref,
   schedule_time, schedule_enabled, retention_count, retention_days, is_active, created_at, updated_at,
   schedule_frequency, schedule_days_of_week, schedule_day_of_month, backup_set_id, windows_task_name)
SELECT
  id, client_id, strategy, transport_id, database_connection_id, name, db_engine,
  remote_path, remote_file_pattern, remote_command, remote_output_path_template, remote_cleanup,
  remote_dump_exec_mode, docker_container, remote_dump_database, remote_dump_db_user, remote_dump_db_password_secret_ref,
  schedule_time, schedule_enabled, retention_count, retention_days, is_active, created_at, updated_at,
  schedule_frequency, schedule_days_of_week, schedule_day_of_month, backup_set_id, windows_task_name
FROM backup_tasks;

DROP TABLE backup_tasks;
ALTER TABLE backup_tasks_new RENAME TO backup_tasks;

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
  schedule_frequency TEXT NOT NULL DEFAULT 'daily' CHECK (schedule_frequency IN ('daily','weekly','monthly','hourly')),
  schedule_days_of_week TEXT,
  schedule_day_of_month INTEGER,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  backup_set_id TEXT REFERENCES backup_sets(id) ON DELETE SET NULL,
  windows_task_name TEXT,
  schedule_interval_hours INTEGER,
  CHECK (
    (source_kind = 'local_folder' AND source_path IS NOT NULL AND transport_id IS NULL AND remote_source_path IS NULL)
    OR
    (source_kind = 'remote_folder' AND source_path IS NULL AND transport_id IS NOT NULL AND remote_source_path IS NOT NULL)
  )
);

INSERT INTO file_backup_tasks_new
  (id, client_id, repository_id, name, source_kind, source_path, transport_id, remote_source_path,
   retention_count, retention_days, schedule_time, schedule_enabled, schedule_frequency,
   schedule_days_of_week, schedule_day_of_month, is_active, created_at, updated_at,
   backup_set_id, windows_task_name)
SELECT
  id, client_id, repository_id, name, source_kind, source_path, transport_id, remote_source_path,
  retention_count, retention_days, schedule_time, schedule_enabled, schedule_frequency,
  schedule_days_of_week, schedule_day_of_month, is_active, created_at, updated_at,
  backup_set_id, windows_task_name
FROM file_backup_tasks;

DROP TABLE file_backup_tasks;
ALTER TABLE file_backup_tasks_new RENAME TO file_backup_tasks;

ALTER TABLE file_backup_runs ADD COLUMN trigger TEXT NOT NULL DEFAULT 'manual' CHECK (trigger IN ('manual','scheduled'));

PRAGMA foreign_keys=ON;
