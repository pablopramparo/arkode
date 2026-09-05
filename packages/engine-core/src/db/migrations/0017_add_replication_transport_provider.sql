-- Adds 'rclone_sftp'/'rclone_ftp' as replication_targets.provider options,
-- alongside the existing Google-Drive-only 'rclone_drive'. Unlike Drive
-- (which needs its own OAuth token JSON stored under
-- rclone_config_secret_ref), an sftp/ftp destination reuses an existing
-- Conexiones transport for its host/credentials -- so this adds a nullable
-- transport_id FK and makes rclone_config_secret_ref itself nullable
-- (exactly one of the two is set, enforced by the new CHECK below).
--
-- Also adds sftp_host_key/sftp_host_key_fingerprint: rclone's own sftp
-- backend does NOT verify the remote host's SSH key by default (confirmed
-- against rclone's docs), unlike this app's existing ssh2-based transports,
-- which always go through buildHostVerifier's TOFU-with-confirmation flow.
-- These columns hold a real pinned host key (rclone's "algo base64-key"
-- host_keys format) captured on the target's first successful test/run, so
-- every subsequent sync verifies against it independently -- not left as a
-- known gap.
--
-- Widening the provider CHECK and dropping rclone_config_secret_ref's
-- NOT NULL both require SQLite's documented 12-step table-rebuild procedure
-- (neither is a plain ALTER TABLE ADD COLUMN). Existing rows are all
-- provider='rclone_drive' with transport_id/sftp_host_key* naturally NULL,
-- which already satisfies the new CHECK -- copied across unchanged, ids
-- preserved so replication_runs.target_id stays valid.
PRAGMA foreign_keys=OFF;

CREATE TABLE replication_targets_new (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  content TEXT NOT NULL CHECK (content IN ('restic_repo','db_dumps')),
  provider TEXT NOT NULL DEFAULT 'rclone_drive' CHECK (provider IN ('rclone_drive','rclone_sftp','rclone_ftp')),
  -- Destination folder inside the remote, e.g. "arkode/Winners/repo".
  remote_path TEXT NOT NULL,
  -- rclone_drive only: SecretStore ref -> JSON RcloneDriveConfig (token, teamDrive?, etc.).
  rclone_config_secret_ref TEXT,
  -- rclone_sftp/rclone_ftp only: an existing transports row supplies host/port/username + credentials.
  transport_id TEXT REFERENCES transports(id),
  -- rclone_sftp only: the pinned host key, rclone host_keys format ("algo base64key"), captured on first use.
  sftp_host_key TEXT,
  -- rclone_sftp only: SHA256 fingerprint of the same key, for display only.
  sftp_host_key_fingerprint TEXT,
  encrypt_with_crypt INTEGER NOT NULL DEFAULT 0 CHECK (encrypt_with_crypt IN (0,1)),
  -- SecretStore ref -> the rclone `crypt` password (plaintext; rclone-"obscured" only when written to the temp config). Required iff encrypt_with_crypt = 1.
  crypt_password_secret_ref TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  last_replicated_at TEXT,
  last_status TEXT CHECK (last_status IN ('Success','Warning','Failed')),
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(client_id, content),
  CHECK (
    (provider = 'rclone_drive' AND rclone_config_secret_ref IS NOT NULL AND transport_id IS NULL)
    OR
    (provider IN ('rclone_sftp','rclone_ftp') AND transport_id IS NOT NULL AND rclone_config_secret_ref IS NULL)
  )
);

INSERT INTO replication_targets_new
  (id, client_id, content, provider, remote_path, rclone_config_secret_ref,
   encrypt_with_crypt, crypt_password_secret_ref, enabled,
   last_replicated_at, last_status, last_error, created_at, updated_at)
SELECT
  id, client_id, content, provider, remote_path, rclone_config_secret_ref,
  encrypt_with_crypt, crypt_password_secret_ref, enabled,
  last_replicated_at, last_status, last_error, created_at, updated_at
FROM replication_targets;

DROP TABLE replication_targets;
ALTER TABLE replication_targets_new RENAME TO replication_targets;

PRAGMA foreign_keys=ON;
