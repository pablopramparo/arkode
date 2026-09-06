-- Adds 'google_drive' as a vault_backup_targets.kind, alongside 'local_dir'.
--
-- A google_drive target uploads the (already master-password-encrypted)
-- .arkvault to Google Drive through the SAME vendored rclone.exe + OAuth
-- flow the off-site replication feature uses:
--   * rclone `copyto` (a single file), NOT `sync` (no mirror, no deletions);
--   * NO extra rclone `crypt` wrapper -- the .arkvault is self-encrypted;
--   * its OAuth token JSON lives in the Tier-1 DPAPI SecretStore under
--     rclone_config_secret_ref, exactly like replication_targets;
--   * and it is ALSO carried (encrypted) inside .arkvault v2's payload, so
--     after a disaster-recovery restore the remote backup resumes with no
--     re-authorization.
--
-- Widening the kind CHECK and adding the google_drive columns is not a plain
-- ALTER TABLE (the CHECK), so this is SQLite's documented 12-step table
-- rebuild -- same pattern as 0004/0008/0011/0017. vault_backup_runs is
-- untouched; its target_id FK stays valid because ids are preserved. Any
-- existing rows are all kind='local_dir' with the new columns naturally
-- NULL, which satisfies the new CHECK, so they copy across unchanged.
PRAGMA foreign_keys=OFF;

CREATE TABLE vault_backup_targets_new (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('local_dir','google_drive')),
  -- local_dir only: an absolute directory on this machine.
  path TEXT,
  -- google_drive only: destination folder inside the Drive account, e.g. "Arkode/Vault".
  remote_path TEXT,
  -- google_drive only: SecretStore (Tier-1 DPAPI) ref -> JSON RcloneDriveConfig
  -- { token, clientId?, clientSecret?, teamDrive?, rootFolderId? }. The ref is
  -- present from creation; the secret itself is absent until the account is authorized.
  rclone_config_secret_ref TEXT,
  -- google_drive only: display label (e.g. the connected account e-mail). Optional.
  label TEXT,
  retention_count INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  last_run_at TEXT,
  last_status TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (
    (kind = 'local_dir'    AND path IS NOT NULL AND remote_path IS NULL AND rclone_config_secret_ref IS NULL)
    OR
    (kind = 'google_drive' AND path IS NULL AND remote_path IS NOT NULL AND rclone_config_secret_ref IS NOT NULL)
  )
);

INSERT INTO vault_backup_targets_new
  (id, kind, path, retention_count, enabled, last_run_at, last_status, last_error, created_at, updated_at)
SELECT
  id, kind, path, retention_count, enabled, last_run_at, last_status, last_error, created_at, updated_at
FROM vault_backup_targets;

DROP TABLE vault_backup_targets;
ALTER TABLE vault_backup_targets_new RENAME TO vault_backup_targets;

PRAGMA foreign_keys=ON;
