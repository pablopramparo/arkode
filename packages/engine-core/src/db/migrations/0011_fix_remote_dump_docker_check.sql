-- Fixes a real gap left by 0010: backup_tasks' existing multi-column CHECK
-- (from 0008) requires remote_command IS NOT NULL for *every* remote_dump
-- task, unconditionally — true for exec_mode 'host' (unchanged), but wrong
-- for 'docker', which builds its own command instead and never sets
-- remote_command at all. 0010 only added the new columns (a plain ALTER
-- TABLE ADD COLUMN, since a fresh install has no docker-mode tasks to
-- conflict with anything yet) without touching the CHECK itself — SQLite
-- can't ALTER a CHECK in place, so this needs the same 12-step rebuild
-- procedure already used by 0004/0007/0008/0010's own remote_dump/backup_tasks
-- history, as its own migration rather than editing 0010's already-applied
-- file in place (migrations are tracked by filename in schema_migrations —
-- rewriting an already-applied file's content would silently never re-run
-- on a database that already recorded it, which is exactly the mistake
-- this migration exists to correct for real, having been caught before
-- shipping to any real production database).
PRAGMA foreign_keys=OFF;

CREATE TABLE backup_tasks_new (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  strategy TEXT NOT NULL CHECK (strategy IN ('fetch_existing','remote_dump','direct_dump')),
  transport_id TEXT REFERENCES transports(id) ON DELETE CASCADE,
  database_connection_id TEXT REFERENCES database_connections(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  db_engine TEXT NOT NULL CHECK (db_engine IN ('postgres','mysql','mariadb','unknown')),
  remote_path TEXT,                        -- fetch_existing only
  remote_file_pattern TEXT,                -- fetch_existing only
  remote_command TEXT,                     -- remote_dump, exec_mode 'host' only
  remote_output_path_template TEXT,        -- remote_dump only (both exec modes)
  remote_cleanup INTEGER NOT NULL DEFAULT 0 CHECK (remote_cleanup IN (0,1)),
  remote_dump_exec_mode TEXT NOT NULL DEFAULT 'host' CHECK (remote_dump_exec_mode IN ('host','docker')),
  docker_container TEXT,                   -- remote_dump, exec_mode 'docker' only
  remote_dump_database TEXT,               -- remote_dump, exec_mode 'docker' only
  remote_dump_db_user TEXT,                -- remote_dump, exec_mode 'docker' only
  remote_dump_db_password_secret_ref TEXT, -- remote_dump, exec_mode 'docker' only, and itself optional even then
  schedule_time TEXT,
  schedule_enabled INTEGER NOT NULL DEFAULT 1 CHECK (schedule_enabled IN (0,1)),
  retention_count INTEGER,
  retention_days INTEGER,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  schedule_frequency TEXT NOT NULL DEFAULT 'daily' CHECK (schedule_frequency IN ('daily','weekly','monthly')),
  schedule_days_of_week TEXT,
  schedule_day_of_month INTEGER,
  backup_set_id TEXT REFERENCES backup_sets(id) ON DELETE SET NULL,
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
   schedule_frequency, schedule_days_of_week, schedule_day_of_month, backup_set_id)
SELECT
  id, client_id, strategy, transport_id, database_connection_id, name, db_engine,
  remote_path, remote_file_pattern, remote_command, remote_output_path_template, remote_cleanup,
  remote_dump_exec_mode, docker_container, remote_dump_database, remote_dump_db_user, remote_dump_db_password_secret_ref,
  schedule_time, schedule_enabled, retention_count, retention_days, is_active, created_at, updated_at,
  schedule_frequency, schedule_days_of_week, schedule_day_of_month, backup_set_id
FROM backup_tasks;

DROP TABLE backup_tasks;
ALTER TABLE backup_tasks_new RENAME TO backup_tasks;

PRAGMA foreign_keys=ON;
