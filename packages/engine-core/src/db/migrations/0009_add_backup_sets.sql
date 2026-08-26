-- backup_sets: a pure visual/reporting label grouping several existing
-- tasks (DB-backup and/or file-backup) under one name per client, e.g.
-- "Sitio X" = its database task + its uploads-folder task. Deliberately NOT
-- a scheduling/execution concept -- each task keeps its own independent
-- schedule and runs independently; a set has no shared schedule, no "run
-- all," no aggregate health row. Shown as a small label wherever tasks/runs
-- already list today, nothing more.
--
-- Both ALTER TABLE ADD COLUMNs below are plain nullable columns (a
-- REFERENCES clause on an added column needs no rebuild in SQLite), unlike
-- the CHECK-driven rebuilds 0004/0007/0008 needed -- backup_set_id isn't
-- part of any CHECK constraint on either table.
CREATE TABLE backup_sets (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(client_id, name)
);

ALTER TABLE backup_tasks ADD COLUMN backup_set_id TEXT REFERENCES backup_sets(id) ON DELETE SET NULL;
ALTER TABLE file_backup_tasks ADD COLUMN backup_set_id TEXT REFERENCES backup_sets(id) ON DELETE SET NULL;
