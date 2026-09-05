import type { Database } from 'better-sqlite3';
import { decryptString, encryptString } from './crypto.js';
import type { VaultState } from './vaultState.js';

/**
 * A `SecretStore`-shaped API (get/set/delete by opaque ref) for Tier 2
 * vault secrets, backed by the `vault_secrets` table and the master-password
 * DEK held in `VaultState`.
 *
 * Differences from `MachineDpapiSecretStore` (Tier 1), all deliberate:
 *  - every method throws `VaultLockedError` (via `vaultState.withDek`) when
 *    the vault is locked;
 *  - `get` returns `null` ONLY for an absent ref; a row that fails to
 *    decrypt throws `VaultCryptoError` (a corrupted secret is a real
 *    problem, not "no secret").
 */
export interface VaultSecretStore {
  get(ref: string): string | null;
  set(ref: string, value: string): void;
  delete(ref: string): void;
  has(ref: string): boolean;
}

interface CiphertextRow {
  ciphertext: Buffer;
}

export function createVaultSecretStore(db: Database, vaultState: VaultState): VaultSecretStore {
  const getStmt = db.prepare<[string], CiphertextRow>('SELECT ciphertext FROM vault_secrets WHERE ref = ?');
  const existsStmt = db.prepare<[string], { one: number }>('SELECT 1 AS one FROM vault_secrets WHERE ref = ?');
  const upsertStmt = db.prepare(
    `INSERT INTO vault_secrets (ref, ciphertext) VALUES (@ref, @ciphertext)
     ON CONFLICT(ref) DO UPDATE SET ciphertext = excluded.ciphertext, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  );
  const deleteStmt = db.prepare('DELETE FROM vault_secrets WHERE ref = ?');

  return {
    get(ref) {
      const row = getStmt.get(ref);
      if (!row) return null;
      return vaultState.withDek((dek) => decryptString(row.ciphertext, dek));
    },
    set(ref, value) {
      vaultState.withDek((dek) => {
        upsertStmt.run({ ref, ciphertext: encryptString(value, dek) });
      });
    },
    delete(ref) {
      // Deleting a ciphertext needs no key.
      deleteStmt.run(ref);
    },
    has(ref) {
      return existsStmt.get(ref) !== undefined;
    },
  };
}
