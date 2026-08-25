-- Replaces Windows Credential Manager (CurrentUser-scope DPAPI — only
-- decryptable within the login session of the specific user who created
-- it) with our own table of LocalMachine-scope-DPAPI-encrypted blobs (see
-- secrets/machineDpapiStore.ts). This is what lets a task's Windows
-- Scheduled Task run as SYSTEM with no password ever required, instead of
-- needing the interactive user's real login password at registration time.
CREATE TABLE secrets (
  ref TEXT PRIMARY KEY,
  ciphertext BLOB NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
