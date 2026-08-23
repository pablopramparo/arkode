-- Codebius Backup Manager — initial schema.
-- Three separate concepts: backup strategy (backup_tasks.strategy),
-- transport (transports — SFTP/SSH byte movement), and database connection
-- (database_connections — direct DB credentials, used only by direct_dump).
--
-- schema_migrations itself is bootstrapped by db/migrate.ts before any
-- migration file runs, so it is deliberately not created here.

CREATE TABLE clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  local_base_path TEXT NOT NULL,
  retention_count INTEGER,
  retention_days INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Transport: how bytes move between a remote host and this PC.
-- Used only by the fetch_existing (sftp) and remote_dump (ssh) strategies.
CREATE TABLE transports (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('sftp','ssh')),
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 22,
  username TEXT NOT NULL,
  private_key_path TEXT NOT NULL,
  passphrase_secret_ref TEXT,
  remote_path TEXT,                        -- sftp only
  remote_file_pattern TEXT,                -- sftp only
  remote_command TEXT,                     -- ssh only
  remote_output_path_template TEXT,        -- ssh only
  remote_cleanup INTEGER NOT NULL DEFAULT 0 CHECK (remote_cleanup IN (0,1)),
  known_host_fingerprint TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (
    (type = 'sftp' AND remote_path IS NOT NULL AND remote_command IS NULL)
    OR
    (type = 'ssh'  AND remote_command IS NOT NULL AND remote_output_path_template IS NOT NULL)
  )
);

-- Database connection: real DB credentials, used only by the direct_dump
-- strategy (not implemented yet). Kept empty/unused until that strategy ships.
CREATE TABLE database_connections (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  engine TEXT NOT NULL CHECK (engine IN ('postgres','mysql')),
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  database_name TEXT NOT NULL,
  username TEXT NOT NULL,
  password_secret_ref TEXT,
  ssl_mode TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE backup_tasks (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  strategy TEXT NOT NULL CHECK (strategy IN ('fetch_existing','remote_dump','direct_dump')),
  transport_id TEXT REFERENCES transports(id) ON DELETE CASCADE,
  database_connection_id TEXT REFERENCES database_connections(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  db_engine TEXT NOT NULL CHECK (db_engine IN ('postgres','mysql','unknown')),
  schedule_time TEXT,
  schedule_enabled INTEGER NOT NULL DEFAULT 1 CHECK (schedule_enabled IN (0,1)),
  retention_count INTEGER,
  retention_days INTEGER,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (
    (strategy IN ('fetch_existing','remote_dump') AND transport_id IS NOT NULL AND database_connection_id IS NULL)
    OR
    (strategy = 'direct_dump' AND database_connection_id IS NOT NULL AND transport_id IS NULL)
  )
);
-- App-level invariant, not expressible as a portable cross-table CHECK:
-- fetch_existing requires transports.type='sftp'; remote_dump requires transports.type='ssh'.
-- Enforced in db/repositories/tasksRepo.ts.

CREATE TABLE backup_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES backup_tasks(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  strategy TEXT NOT NULL CHECK (strategy IN ('fetch_existing','remote_dump','direct_dump')),
  transport_id TEXT REFERENCES transports(id),
  database_connection_id TEXT REFERENCES database_connections(id),
  status TEXT NOT NULL CHECK (status IN
    ('Pending','Running','Producing','Validating','Success','Warning','Failed')),
  remote_file_name TEXT,
  remote_path TEXT,
  remote_modified_at TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  downloaded_at TEXT,
  local_path TEXT,
  size_bytes INTEGER,
  checksum_sha256 TEXT,
  duration_ms INTEGER,
  error_message TEXT,
  error_stack TEXT,
  log_file_path TEXT,
  pid INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_backup_runs_task   ON backup_runs(task_id, started_at DESC);
CREATE INDEX idx_backup_runs_client ON backup_runs(client_id, started_at DESC);
CREATE INDEX idx_backup_runs_status ON backup_runs(status);

CREATE TABLE retention_deletions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES backup_tasks(id) ON DELETE CASCADE,
  deleted_backup_run_id TEXT NOT NULL REFERENCES backup_runs(id),
  triggered_by_run_id TEXT REFERENCES backup_runs(id),
  local_path TEXT NOT NULL,
  size_bytes INTEGER,
  reason TEXT NOT NULL,
  deleted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE known_hosts (
  id TEXT PRIMARY KEY,
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 22,
  key_type TEXT NOT NULL,
  fingerprint_sha256 TEXT NOT NULL,
  first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  confirmed_at TEXT,
  UNIQUE(host, port, key_type)
);

CREATE TABLE log_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT REFERENCES backup_runs(id) ON DELETE CASCADE,
  level TEXT NOT NULL CHECK (level IN ('debug','info','warn','error')),
  step TEXT,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_log_events_run ON log_events(run_id, created_at);

CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
