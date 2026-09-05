import type { Database } from 'better-sqlite3';
import type { ScryptParams } from './crypto.js';

export interface VaultMetaRow {
  formatVersion: number;
  kdf: string;
  kdfParams: ScryptParams;
  kekSalt: Buffer;
  wrappedDek: Buffer;
  verifier: Buffer;
  initializedAt: string;
  updatedAt: string;
}

/** Fields the caller supplies; timestamps are managed by the repo. */
export type PutVaultMetaInput = Omit<VaultMetaRow, 'initializedAt' | 'updatedAt'>;

export interface VaultMetaRepo {
  /** The single vault_meta row, or null when the vault has never been initialized. */
  get(): VaultMetaRow | null;
  /** Creates the row (id=1) — fails if it already exists. */
  create(input: PutVaultMetaInput): void;
  /** Replaces the crypto material on the existing row (used by change-password). */
  updateCrypto(input: Pick<PutVaultMetaInput, 'kdf' | 'kdfParams' | 'kekSalt' | 'wrappedDek' | 'verifier'>): void;
}

interface VaultMetaDbRow {
  format_version: number;
  kdf: string;
  kdf_params: string;
  kek_salt: Buffer;
  wrapped_dek: Buffer;
  verifier: Buffer;
  initialized_at: string;
  updated_at: string;
}

function toDomain(row: VaultMetaDbRow): VaultMetaRow {
  return {
    formatVersion: row.format_version,
    kdf: row.kdf,
    kdfParams: JSON.parse(row.kdf_params) as ScryptParams,
    kekSalt: row.kek_salt,
    wrappedDek: row.wrapped_dek,
    verifier: row.verifier,
    initializedAt: row.initialized_at,
    updatedAt: row.updated_at,
  };
}

export function createVaultMetaRepo(db: Database): VaultMetaRepo {
  const getStmt = db.prepare<[], VaultMetaDbRow>('SELECT * FROM vault_meta WHERE id = 1');
  const insertStmt = db.prepare(
    `INSERT INTO vault_meta (id, format_version, kdf, kdf_params, kek_salt, wrapped_dek, verifier)
     VALUES (1, @formatVersion, @kdf, @kdfParams, @kekSalt, @wrappedDek, @verifier)`
  );
  const updateStmt = db.prepare(
    `UPDATE vault_meta
       SET kdf = @kdf, kdf_params = @kdfParams, kek_salt = @kekSalt, wrapped_dek = @wrappedDek,
           verifier = @verifier, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = 1`
  );

  return {
    get() {
      const row = getStmt.get();
      return row ? toDomain(row) : null;
    },
    create(input) {
      insertStmt.run({
        formatVersion: input.formatVersion,
        kdf: input.kdf,
        kdfParams: JSON.stringify(input.kdfParams),
        kekSalt: input.kekSalt,
        wrappedDek: input.wrappedDek,
        verifier: input.verifier,
      });
    },
    updateCrypto(input) {
      const result = updateStmt.run({
        kdf: input.kdf,
        kdfParams: JSON.stringify(input.kdfParams),
        kekSalt: input.kekSalt,
        wrappedDek: input.wrappedDek,
        verifier: input.verifier,
      });
      if (result.changes === 0) throw new Error('vault_meta row does not exist — the vault is not initialized.');
    },
  };
}
