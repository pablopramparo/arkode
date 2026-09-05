-- Structured credentials (Tier 2). Plaintext metadata columns for
-- locked-state search; the sensitive fields live as ONE AES-256-GCM blob in
-- vault_secrets, referenced by secret_blob_ref.
--
-- linked_transport_id / linked_database_connection_id are the "reuse
-- bridge" (Phase 3): a credential may own the connection a backup job uses.
-- The two partial UNIQUE indexes enforce one-owner-per-connection so two
-- credentials can never sync different secrets into the same Tier 1 row;
-- which of the two a credential may use is gated app-side by `kind`.
--
-- The `transports` CHECK still requires private_key_path for sftp/ssh, so a
-- LINKED ssh transport always keeps a regenerable operational key file;
-- only an UNLINKED vault ssh credential has no key file on disk. No
-- transports/database_connections rebuild — their CHECKs are untouched.
--
-- Plain CREATE TABLE + CREATE INDEX, additive, no rebuild.

CREATE TABLE vault_credentials (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  environment TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  host TEXT,
  port INTEGER,
  username TEXT,
  database_name TEXT,
  url TEXT,
  secret_blob_ref TEXT,
  linked_transport_id TEXT REFERENCES transports(id) ON DELETE SET NULL,
  linked_database_connection_id TEXT REFERENCES database_connections(id) ON DELETE SET NULL,
  operational_sync_state TEXT NOT NULL DEFAULT 'none'
    CHECK (operational_sync_state IN ('none','pending','ok','error')),
  operational_sync_error TEXT,
  favorite INTEGER NOT NULL DEFAULT 0 CHECK (favorite IN (0,1)),
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_vault_credentials_client ON vault_credentials(client_id, name);
CREATE INDEX idx_vault_credentials_favorite ON vault_credentials(client_id, favorite);

CREATE UNIQUE INDEX ux_vault_credentials_transport
  ON vault_credentials(linked_transport_id) WHERE linked_transport_id IS NOT NULL;
CREATE UNIQUE INDEX ux_vault_credentials_dbconn
  ON vault_credentials(linked_database_connection_id) WHERE linked_database_connection_id IS NOT NULL;
