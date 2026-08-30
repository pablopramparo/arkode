-- Off-site replication of backups to Google Drive (via rclone), a
-- deliberately opt-in copy layer that runs AFTER a backup finished --
-- it never touches the proven backup orchestrators or the restic engine.
--
-- Two brand-new plain tables (no rebuild of anything existing):
--
--  * replication_targets -- one per (client, content) pair.
--      content = 'restic_repo' -> rclone sync of {client}\_restic-repo
--      content = 'db_dumps'    -> rclone sync of the client's DB-dump tree
--    UNIQUE(client_id, content) fixes the "per client and per type"
--    granularity the user asked for: each row carries its OWN rclone
--    remote config (its own Google account, via SecretStore) and its own
--    remote_path. There is no global/shared Drive config anywhere.
--    The two content kinds are independent -- a client may have only one,
--    both, or neither. Nothing is forced.
--
--  * replication_runs -- one row per replication attempt, mirroring
--    file_backup_maintenance_runs' shape (status state machine +
--    pid for recycled-PID-safe stale recovery via util/processIdentity).
--
-- Encryption: a restic repo is already encrypted at rest, so 'restic_repo'
-- targets sync raw ciphertext (Google never sees plaintext, the recovery
-- key never leaves this machine). DB dumps are NOT encrypted at rest, so a
-- 'db_dumps' target wraps the upload in an rclone `crypt` remote with its
-- own password (encrypt_with_crypt / crypt_password_secret_ref).

CREATE TABLE replication_targets (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  content TEXT NOT NULL CHECK (content IN ('restic_repo','db_dumps')),
  provider TEXT NOT NULL DEFAULT 'rclone_drive' CHECK (provider IN ('rclone_drive')),
  -- Destination folder inside the Drive account, e.g. "arkode/Winners/repo".
  remote_path TEXT NOT NULL,
  -- SecretStore ref -> JSON describing the rclone remote: { token, teamDrive?, rootFolderId?, clientId?, clientSecret? }.
  -- NULL-authorized targets (row exists, no token yet) keep this ref but the secret is absent until authorize.
  rclone_config_secret_ref TEXT NOT NULL,
  encrypt_with_crypt INTEGER NOT NULL DEFAULT 0 CHECK (encrypt_with_crypt IN (0,1)),
  -- SecretStore ref -> the rclone `crypt` password (plaintext; rclone-"obscured" only when written to the temp config). Required iff encrypt_with_crypt = 1.
  crypt_password_secret_ref TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  last_replicated_at TEXT,
  last_status TEXT CHECK (last_status IN ('Success','Warning','Failed')),
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(client_id, content)
);

CREATE TABLE replication_runs (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL REFERENCES replication_targets(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  -- 'scheduled' = started by the arkode-scheduler service tick; 'manual' = "Copiar ahora" / replication:run.
  trigger TEXT NOT NULL CHECK (trigger IN ('manual','scheduled')),
  status TEXT NOT NULL CHECK (status IN ('Running','Success','Warning','Failed')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  duration_ms INTEGER,
  bytes_transferred INTEGER,
  files_transferred INTEGER,
  files_deleted INTEGER,
  error_message TEXT,
  pid INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_replication_runs_target ON replication_runs(target_id, started_at DESC);
CREATE INDEX idx_replication_runs_client ON replication_runs(client_id, started_at DESC);
