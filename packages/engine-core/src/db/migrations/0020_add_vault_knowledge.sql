-- Project operational knowledge (Tier 2): URLs, snippets, processes, notes.
-- Plaintext by default (searchable while the vault is locked); a snippet /
-- note / process can be flagged sensitive, which moves its body into an
-- encrypted blob (body_blob_ref -> vault_secrets). URLs are always plaintext.
--
-- Plain CREATE TABLE + CREATE INDEX, additive, no rebuild.

CREATE TABLE vault_urls (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  environment TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  linked_credential_id TEXT REFERENCES vault_credentials(id) ON DELETE SET NULL,
  favorite INTEGER NOT NULL DEFAULT 0 CHECK (favorite IN (0,1)),
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_vault_urls_client ON vault_urls(client_id, name);

CREATE TABLE vault_items (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('snippet','process','note')),
  title TEXT NOT NULL,
  environment TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  description TEXT,
  favorite INTEGER NOT NULL DEFAULT 0 CHECK (favorite IN (0,1)),
  is_sensitive INTEGER NOT NULL DEFAULT 0 CHECK (is_sensitive IN (0,1)),
  body_plaintext TEXT,
  body_blob_ref TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_vault_items_client ON vault_items(client_id, type);
