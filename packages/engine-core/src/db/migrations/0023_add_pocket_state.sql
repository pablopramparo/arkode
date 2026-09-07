-- Arkode Pocket (the read-only mobile credential viewer) — Desktop-side
-- state only. See docs/pocket.md for the full architecture. This is
-- deliberately its own tiny, additive slice: it does not touch vault_meta,
-- vault_secrets, vault_credentials, vault_urls, or any backup-domain table.
--
-- Single-row singleton (same "id pinned to 1" pattern as vault_meta).
-- The Pocket DEK itself is NOT a column here — it lives in the existing
-- Tier-1 `secrets` table (DPAPI LocalMachine, same mechanism as every other
-- operational secret) under the fixed ref 'pocket:dek', so this table only
-- ever holds non-secret state.
CREATE TABLE pocket_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),

  pocket_id TEXT NOT NULL,
  configured INTEGER NOT NULL DEFAULT 0 CHECK (configured IN (0,1)),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),

  -- Google Drive destination (rclone, Desktop-side only — reuses the same
  -- rclone plumbing replication/vault-backup already use).
  drive_remote_path TEXT,
  drive_file_id TEXT,

  -- Dirty / revision bookkeeping.
  --
  -- `change_seq` is incremented by the SQL triggers below on every
  -- Pocket-relevant mutation, never by application code, so no future call
  -- site (CLI, serve, import, anything) can forget to mark Pocket stale.
  -- `published_seq` is the `change_seq` value that was current at the START
  -- of the most recently CONFIRMED publish. Pocket is dirty iff
  -- change_seq > published_seq — a plain boolean flag can't safely handle a
  -- mutation that lands WHILE a publish is uploading (an `await` point),
  -- because clearing a boolean after that upload would silently swallow the
  -- concurrent edit; a monotonic counter captured before the attempt and
  -- compared after naturally keeps `dirty` true in that case, correctly
  -- queuing the follow-up publish. See runPocketPublish.ts.
  --
  -- `last_confirmed_revision` / `last_attempted_revision` are the
  -- user-facing "Revisión: N" counters — a small integer counting REAL
  -- confirmed publishes, deliberately separate from the internal
  -- `change_seq` (which counts every mutation and would be a meaningless
  -- number to show anyone).
  change_seq INTEGER NOT NULL DEFAULT 0,
  published_seq INTEGER NOT NULL DEFAULT 0,
  dirty_since TEXT,
  last_attempted_revision INTEGER,
  last_confirmed_revision INTEGER,
  last_attempt_at TEXT,
  last_successful_publish_at TEXT,
  last_error TEXT,

  -- v1 = a single conceptual device. No device table, no heartbeats, no
  -- presence — Desktop genuinely cannot know when/whether a phone last
  -- pulled a revision (see docs/pocket.md's "what Desktop can and cannot
  -- know" section).
  device_label TEXT,
  paired_at TEXT,
  revoked_at TEXT,

  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ---------------------------------------------------------------------------
-- Dirty-tracking triggers. Deliberately implemented at the SQLite level
-- (not as an explicit `markDirty()` call threaded through every repo/CLI
-- command/serve endpoint that can mutate a credential or URL) so this
-- invariant cannot be silently broken by a future call site that forgets to
-- call it — a missed call site here is a real product bug (a phone that
-- silently never learns about a changed password), not just a style choice.
-- No-ops harmlessly before Pocket is configured (the UPDATE simply matches
-- no row).
-- ---------------------------------------------------------------------------

CREATE TRIGGER trg_pocket_dirty_credential_insert
AFTER INSERT ON vault_credentials
BEGIN
  UPDATE pocket_state
     SET change_seq = change_seq + 1,
         dirty_since = CASE WHEN change_seq = published_seq THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE dirty_since END
   WHERE id = 1;
END;

CREATE TRIGGER trg_pocket_dirty_credential_update
AFTER UPDATE OF name, kind, environment, tags, host, port, username, database_name, url, favorite, description
ON vault_credentials
BEGIN
  UPDATE pocket_state
     SET change_seq = change_seq + 1,
         dirty_since = CASE WHEN change_seq = published_seq THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE dirty_since END
   WHERE id = 1;
END;

CREATE TRIGGER trg_pocket_dirty_credential_delete
AFTER DELETE ON vault_credentials
BEGIN
  UPDATE pocket_state
     SET change_seq = change_seq + 1,
         dirty_since = CASE WHEN change_seq = published_seq THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE dirty_since END
   WHERE id = 1;
END;

-- A credential's SECRET (password/token/etc) lives in vault_secrets, keyed
-- by a ref of the form 'vault:credential:<uuid>' (see credentialBlob.ts) —
-- changing it never touches the vault_credentials row itself, so it needs
-- its own trigger, narrowed to that ref prefix (vault_secrets also holds
-- vault_items' sensitive bodies, under 'vault:item:<uuid>' refs, which must
-- NOT dirty Pocket — notes/snippets/processes are out of scope for v1).
CREATE TRIGGER trg_pocket_dirty_secret_insert
AFTER INSERT ON vault_secrets
WHEN NEW.ref LIKE 'vault:credential:%'
BEGIN
  UPDATE pocket_state
     SET change_seq = change_seq + 1,
         dirty_since = CASE WHEN change_seq = published_seq THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE dirty_since END
   WHERE id = 1;
END;

CREATE TRIGGER trg_pocket_dirty_secret_update
AFTER UPDATE ON vault_secrets
WHEN NEW.ref LIKE 'vault:credential:%'
BEGIN
  UPDATE pocket_state
     SET change_seq = change_seq + 1,
         dirty_since = CASE WHEN change_seq = published_seq THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE dirty_since END
   WHERE id = 1;
END;

CREATE TRIGGER trg_pocket_dirty_url_insert
AFTER INSERT ON vault_urls
BEGIN
  UPDATE pocket_state
     SET change_seq = change_seq + 1,
         dirty_since = CASE WHEN change_seq = published_seq THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE dirty_since END
   WHERE id = 1;
END;

CREATE TRIGGER trg_pocket_dirty_url_update
AFTER UPDATE OF name, url, environment, tags, favorite, description ON vault_urls
BEGIN
  UPDATE pocket_state
     SET change_seq = change_seq + 1,
         dirty_since = CASE WHEN change_seq = published_seq THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE dirty_since END
   WHERE id = 1;
END;

CREATE TRIGGER trg_pocket_dirty_url_delete
AFTER DELETE ON vault_urls
BEGIN
  UPDATE pocket_state
     SET change_seq = change_seq + 1,
         dirty_since = CASE WHEN change_seq = published_seq THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE dirty_since END
   WHERE id = 1;
END;

-- Only a client's name (shown in Pocket) and active state (membership in
-- the snapshot) are Pocket-relevant — retention/localBasePath/description
-- etc. are not part of the Pocket payload at all.
CREATE TRIGGER trg_pocket_dirty_client_update
AFTER UPDATE OF name, is_active ON clients
WHEN NEW.name IS NOT OLD.name OR NEW.is_active IS NOT OLD.is_active
BEGIN
  UPDATE pocket_state
     SET change_seq = change_seq + 1,
         dirty_since = CASE WHEN change_seq = published_seq THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE dirty_since END
   WHERE id = 1;
END;
