-- Portable encrypted vault backup (.arkvault). A dedicated, tiny mechanism
-- separate from the restic/DB backup engine (no recursion, no coupling):
-- the whole Tier 2 vault is serialized, AES-256-GCM-encrypted under the DEK,
-- and written to plain filesystem destinations (a OneDrive/GDrive-synced
-- folder is just a path — no cloud APIs). Only encrypted material is ever
-- written to a destination.
--
-- Plain CREATE TABLE + CREATE INDEX, additive, no rebuild.

CREATE TABLE vault_backup_targets (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('local_dir')),
  path TEXT NOT NULL,
  retention_count INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  last_run_at TEXT,
  last_status TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE vault_backup_runs (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL REFERENCES vault_backup_targets(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('Success','Failed')),
  file_path TEXT,
  size_bytes INTEGER,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_vault_backup_runs_target ON vault_backup_runs(target_id, started_at DESC);
