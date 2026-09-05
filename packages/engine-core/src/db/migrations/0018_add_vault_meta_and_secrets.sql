-- Encrypted credential vault (Tier 2). Separate from `secrets` (Tier 1 --
-- DPAPI LocalMachine, machine-bound, readable unattended by the scheduler):
-- these blobs are AES-256-GCM under a key derived from the user's master
-- password via scrypt, so they are PORTABLE (survive PC loss via the
-- .arkvault backup) and unreadable without that password. The two
-- encryption schemes live in separate tables so a decrypt path can never
-- pick the wrong one.
--
-- Plain CREATE TABLE, additive, no rebuild.

-- Single-row table (id is pinned to 1) holding everything needed to unlock:
-- the KDF + its params, the per-password salt, the envelope-wrapped Data
-- Encryption Key, and a verifier (a known plaintext encrypted under the
-- DEK) for fast wrong-password detection. `wrapped_dek` and `verifier` are
-- both self-describing ciphertext blobs (magic|version|alg|nonce|ct|tag) --
-- see vault/crypto.ts. All of this is also copied verbatim into a
-- .arkvault backup so the master password still works after recovery.
CREATE TABLE vault_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  format_version INTEGER NOT NULL,
  kdf TEXT NOT NULL,
  kdf_params TEXT NOT NULL,
  kek_salt BLOB NOT NULL,
  wrapped_dek BLOB NOT NULL,
  verifier BLOB NOT NULL,
  initialized_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- One row per encrypted value, keyed by an opaque ref string (same shape
-- as the `secrets` table). `ciphertext` is a self-describing blob
-- encrypted with the vault DEK. A `NULL`/absent row means "no such secret";
-- a row that fails to decrypt is surfaced as a specific corruption error,
-- never silently as absent.
CREATE TABLE vault_secrets (
  ref TEXT PRIMARY KEY,
  ciphertext BLOB NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
