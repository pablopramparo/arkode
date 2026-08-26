-- A dedicated log_events mirror for the file-backup domain. Needed because
-- log_events.run_id has a real foreign key to backup_runs(id) specifically
-- (see 0001_init.sql) -- confirmed the hard way while building
-- runFileBackupTask.ts that inserting a file_backup_runs id there throws
-- "FOREIGN KEY constraint failed", not a silent no-op. Same shape as
-- log_events on purpose, so the Logs screen can show either domain (or
-- both) through the same table/filter UI.
CREATE TABLE file_backup_log_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT REFERENCES file_backup_runs(id) ON DELETE CASCADE,
  level TEXT NOT NULL CHECK (level IN ('debug','info','warn','error')),
  step TEXT,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_file_backup_log_events_run ON file_backup_log_events(run_id, created_at);
