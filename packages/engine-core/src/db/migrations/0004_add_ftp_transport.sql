-- Adds 'ftp' as a third transports.type, alongside the existing sftp/ssh.
-- FTP authenticates with a username+password, not an SSH private key, so
-- this also has to make private_key_path nullable and add a
-- password_secret_ref column (mirrors passphrase_secret_ref's existing
-- role for SFTP/SSH) -- neither of those is a plain ADD COLUMN/CHECK
-- tweak SQLite supports in place (widening a CHECK or dropping a NOT NULL
-- both require a full table rebuild), so this follows SQLite's documented
-- 12-step "other kinds of schema change" procedure: build the new table
-- alongside the old one, copy every row across unchanged (ids preserved,
-- so backup_tasks.transport_id/backup_runs.transport_id stay valid with no
-- further changes needed), drop the old table, rename the new one into
-- place.
PRAGMA foreign_keys=OFF;

CREATE TABLE transports_new (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('sftp','ssh','ftp')),
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 22,
  username TEXT NOT NULL,
  private_key_path TEXT,                   -- sftp/ssh only now; ftp authenticates with password_secret_ref instead
  passphrase_secret_ref TEXT,
  password_secret_ref TEXT,                -- ftp only
  remote_path TEXT,                        -- sftp/ftp only
  remote_file_pattern TEXT,                -- sftp/ftp only
  remote_command TEXT,                     -- ssh only
  remote_output_path_template TEXT,        -- ssh only
  remote_cleanup INTEGER NOT NULL DEFAULT 0 CHECK (remote_cleanup IN (0,1)),
  known_host_fingerprint TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (
    (type = 'sftp' AND private_key_path IS NOT NULL AND remote_path IS NOT NULL AND remote_command IS NULL)
    OR
    (type = 'ssh'  AND private_key_path IS NOT NULL AND remote_command IS NOT NULL AND remote_output_path_template IS NOT NULL)
    OR
    (type = 'ftp'  AND remote_path IS NOT NULL AND remote_command IS NULL)
  )
);

INSERT INTO transports_new
  (id, client_id, name, type, host, port, username, private_key_path,
   passphrase_secret_ref, password_secret_ref, remote_path, remote_file_pattern,
   remote_command, remote_output_path_template, remote_cleanup, known_host_fingerprint,
   is_active, created_at, updated_at)
SELECT
  id, client_id, name, type, host, port, username, private_key_path,
  passphrase_secret_ref, NULL, remote_path, remote_file_pattern,
  remote_command, remote_output_path_template, remote_cleanup, known_host_fingerprint,
  is_active, created_at, updated_at
FROM transports;

DROP TABLE transports;
ALTER TABLE transports_new RENAME TO transports;

PRAGMA foreign_keys=ON;
