-- Adds the file-backup domain (folders backed up via restic), deliberately
-- as brand-new tables parallel to backup_tasks/backup_runs rather than an
-- extension of them -- restic snapshots don't fit the "one run = one file,
-- one checksum, one local_path" shape those tables and their retention
-- logic are built around, and the DB-backup path is proven/tested and must
-- not be touched. See CLAUDE.md's file-backup design notes for the full
-- reasoning.
--
-- One restic repository per client (file_backup_repositories), shared by
-- however many file_backup_tasks that client has (one per source folder).
-- file_backup_runs mirrors backup_runs' status state machine but records
-- restic-specific metrics (snapshot id, new/changed/unmodified/deleted file
-- counts, physical bytes added) instead of a single file's checksum/path.
-- Retention deletions (restic "forget") and repository maintenance
-- (prune/check, which are repository-scoped, not task-scoped, and
-- deliberately never run as part of a normal backup) each get their own
-- table too.

CREATE TABLE file_backup_repositories (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  repo_path TEXT NOT NULL,
  password_secret_ref TEXT NOT NULL,
  restic_repo_id TEXT,
  last_pruned_at TEXT,
  last_checked_at TEXT,
  initialized_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(client_id)
);

CREATE TABLE file_backup_tasks (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL REFERENCES file_backup_repositories(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  -- 'remote_folder' is a deliberately future value -- not added yet, not
  -- implemented yet. Widening this CHECK will need its own table-rebuild
  -- migration (same procedure as 0004_add_ftp_transport.sql) when that
  -- increment actually happens.
  source_kind TEXT NOT NULL CHECK (source_kind IN ('local_folder')),
  source_path TEXT NOT NULL,
  retention_count INTEGER,
  retention_days INTEGER,
  schedule_time TEXT,
  schedule_enabled INTEGER NOT NULL DEFAULT 1 CHECK (schedule_enabled IN (0,1)),
  schedule_frequency TEXT NOT NULL DEFAULT 'daily' CHECK (schedule_frequency IN ('daily','weekly','monthly')),
  schedule_days_of_week TEXT,
  schedule_day_of_month INTEGER,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE file_backup_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES file_backup_tasks(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL REFERENCES file_backup_repositories(id),
  status TEXT NOT NULL CHECK (status IN ('Pending','Running','Producing','Validating','Success','Warning','Failed')),
  snapshot_id TEXT,
  files_new INTEGER,
  files_changed INTEGER,
  files_unmodified INTEGER,
  files_deleted INTEGER,
  dirs_new INTEGER,
  dirs_changed INTEGER,
  total_files_processed INTEGER,
  total_bytes_processed INTEGER,
  data_added INTEGER,
  data_added_packed INTEGER,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  duration_ms INTEGER,
  error_message TEXT,
  error_stack TEXT,
  warnings TEXT,
  log_file_path TEXT,
  pid INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_file_backup_runs_task ON file_backup_runs(task_id, started_at DESC);
CREATE INDEX idx_file_backup_runs_client ON file_backup_runs(client_id, started_at DESC);
CREATE INDEX idx_file_backup_runs_status ON file_backup_runs(status);

CREATE TABLE file_backup_retention_deletions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES file_backup_tasks(id) ON DELETE CASCADE,
  forgotten_snapshot_id TEXT NOT NULL,
  triggered_by_run_id TEXT REFERENCES file_backup_runs(id),
  reason TEXT NOT NULL,
  forgotten_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE file_backup_maintenance_runs (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES file_backup_repositories(id) ON DELETE CASCADE,
  operation TEXT NOT NULL CHECK (operation IN ('prune','check','check_read_data')),
  status TEXT NOT NULL CHECK (status IN ('Running','Success','Warning','Failed')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  duration_ms INTEGER,
  bytes_reclaimed INTEGER,
  error_message TEXT,
  pid INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_file_backup_maintenance_runs_repo ON file_backup_maintenance_runs(repository_id, started_at DESC);
