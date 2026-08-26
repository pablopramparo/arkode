-- Moves remote_path/remote_file_pattern (fetch_existing) and
-- remote_command/remote_output_path_template/remote_cleanup (remote_dump)
-- from `transports` onto `backup_tasks`. Today these live on the transport,
-- which means two tasks wanting the same server connection but a different
-- remote path/command must duplicate the whole transport just to vary one
-- field -- flagged directly as inflexible. Mirrors the pattern the
-- file-backup domain's remote_folder already uses (remote_source_path lives
-- on file_backup_tasks, not transports) -- transports becomes purely "how to
-- connect," backup_tasks fully owns "what to do with it."
--
-- Neither table change is a plain ALTER TABLE ADD COLUMN (both add/remove
-- columns referenced by a multi-column CHECK), so both need the same 12-step
-- rebuild procedure already used by 0004_add_ftp_transport.sql and
-- 0007_add_remote_folder_tasks.sql. Both rebuilds happen in this one file,
-- inside the one transaction migrate.ts already wraps each file in, and
-- order matters: backup_tasks is rebuilt FIRST, backfilling its new columns
-- via a LEFT JOIN against the still-intact old transports table, before
-- transports loses those columns.
PRAGMA foreign_keys=OFF;

-- Step 1: backup_tasks gains the fields, backfilled from today's transports.
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
  remote_command TEXT,                     -- remote_dump only
  remote_output_path_template TEXT,        -- remote_dump only
  remote_cleanup INTEGER NOT NULL DEFAULT 0 CHECK (remote_cleanup IN (0,1)),
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
  CHECK (
    (strategy = 'fetch_existing' AND transport_id IS NOT NULL AND database_connection_id IS NULL
       AND remote_path IS NOT NULL AND remote_command IS NULL AND remote_output_path_template IS NULL)
    OR
    (strategy = 'remote_dump' AND transport_id IS NOT NULL AND database_connection_id IS NULL
       AND remote_command IS NOT NULL AND remote_output_path_template IS NOT NULL AND remote_path IS NULL)
    OR
    (strategy = 'direct_dump' AND database_connection_id IS NOT NULL AND transport_id IS NULL
       AND remote_path IS NULL AND remote_command IS NULL AND remote_output_path_template IS NULL)
  )
);

INSERT INTO backup_tasks_new
  (id, client_id, strategy, transport_id, database_connection_id, name, db_engine,
   remote_path, remote_file_pattern, remote_command, remote_output_path_template, remote_cleanup,
   schedule_time, schedule_enabled, retention_count, retention_days, is_active, created_at, updated_at,
   schedule_frequency, schedule_days_of_week, schedule_day_of_month)
SELECT
  bt.id, bt.client_id, bt.strategy, bt.transport_id, bt.database_connection_id, bt.name, bt.db_engine,
  t.remote_path, t.remote_file_pattern, t.remote_command, t.remote_output_path_template, COALESCE(t.remote_cleanup, 0),
  bt.schedule_time, bt.schedule_enabled, bt.retention_count, bt.retention_days, bt.is_active, bt.created_at, bt.updated_at,
  bt.schedule_frequency, bt.schedule_days_of_week, bt.schedule_day_of_month
FROM backup_tasks bt
LEFT JOIN transports t ON t.id = bt.transport_id;

DROP TABLE backup_tasks;
ALTER TABLE backup_tasks_new RENAME TO backup_tasks;

-- Step 2: transports loses the fields -- now safe, backup_tasks already has its copy.
CREATE TABLE transports_new (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('sftp','ssh','ftp')),
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 22,
  username TEXT NOT NULL,
  private_key_path TEXT,
  passphrase_secret_ref TEXT,
  password_secret_ref TEXT,
  known_host_fingerprint TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (
    (type IN ('sftp','ssh') AND private_key_path IS NOT NULL)
    OR
    (type = 'ftp')
  )
);

INSERT INTO transports_new
  (id, client_id, name, type, host, port, username, private_key_path,
   passphrase_secret_ref, password_secret_ref, known_host_fingerprint, is_active, created_at, updated_at)
SELECT
  id, client_id, name, type, host, port, username, private_key_path,
  passphrase_secret_ref, password_secret_ref, known_host_fingerprint, is_active, created_at, updated_at
FROM transports;

DROP TABLE transports;
ALTER TABLE transports_new RENAME TO transports;

PRAGMA foreign_keys=ON;
