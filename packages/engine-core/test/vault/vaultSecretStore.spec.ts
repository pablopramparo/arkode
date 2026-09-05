import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { migrationsSourceDir } from '../../src/paths.js';
import { DEFAULT_SCRYPT_PARAMS, VaultCryptoError } from '../../src/vault/crypto.js';
import { createVaultMetaRepo } from '../../src/vault/vaultMetaRepo.js';
import { createVaultState, VaultLockedError } from '../../src/vault/vaultState.js';
import { createVaultSecretStore } from '../../src/vault/vaultSecretStore.js';

const FAST = { ...DEFAULT_SCRYPT_PARAMS, N: 2 ** 12 };

function setup() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrationsSourceDir());
  const vaultState = createVaultState({ vaultMetaRepo: createVaultMetaRepo(db), autoLockMs: null });
  const store = createVaultSecretStore(db, vaultState);
  return { db, vaultState, store };
}

describe('VaultSecretStore', () => {
  it('set/get round-trips a value while unlocked', () => {
    const { vaultState, store } = setup();
    vaultState.init('master', FAST);
    store.set('vault:cred:1:password', 'hunter2');
    expect(store.get('vault:cred:1:password')).toBe('hunter2');
  });

  it('get returns null for an absent ref', () => {
    const { vaultState, store } = setup();
    vaultState.init('master', FAST);
    expect(store.get('nope')).toBeNull();
    expect(store.has('nope')).toBe(false);
  });

  it('has() reports presence without needing the key (works while locked)', () => {
    const { vaultState, store } = setup();
    vaultState.init('master', FAST);
    store.set('ref', 'v');
    vaultState.lock();
    expect(store.has('ref')).toBe(true);
    expect(store.has('other')).toBe(false);
  });

  it('get/set throw VaultLockedError when locked', () => {
    const { vaultState, store } = setup();
    vaultState.init('master', FAST);
    store.set('ref', 'v');
    vaultState.lock();
    expect(() => store.get('ref')).toThrow(VaultLockedError);
    expect(() => store.set('ref', 'v2')).toThrow(VaultLockedError);
  });

  it('delete works while locked and needs no key', () => {
    const { vaultState, store } = setup();
    vaultState.init('master', FAST);
    store.set('ref', 'v');
    vaultState.lock();
    store.delete('ref');
    vaultState.unlock('master');
    expect(store.get('ref')).toBeNull();
  });

  it('values survive a lock/unlock cycle (persisted ciphertext, DEK unchanged)', () => {
    const { vaultState, store } = setup();
    vaultState.init('master', FAST);
    store.set('a', 'alpha');
    store.set('b', 'beta');
    vaultState.lock();
    vaultState.unlock('master');
    expect(store.get('a')).toBe('alpha');
    expect(store.get('b')).toBe('beta');
  });

  it('values survive a master-password change', () => {
    const { vaultState, store } = setup();
    vaultState.init('old', FAST);
    store.set('a', 'alpha');
    vaultState.changePassword('old', 'new', FAST);
    expect(store.get('a')).toBe('alpha');
    vaultState.lock();
    vaultState.unlock('new');
    expect(store.get('a')).toBe('alpha');
  });

  it('a corrupted ciphertext row surfaces VaultCryptoError, not null', () => {
    const { db, vaultState, store } = setup();
    vaultState.init('master', FAST);
    store.set('ref', 'secret');
    // Corrupt the stored blob directly.
    const row = db.prepare('SELECT ciphertext FROM vault_secrets WHERE ref = ?').get('ref') as { ciphertext: Buffer };
    const bad = Buffer.from(row.ciphertext);
    bad[bad.length - 3] ^= 0xff;
    db.prepare('UPDATE vault_secrets SET ciphertext = ? WHERE ref = ?').run(bad, 'ref');
    expect(() => store.get('ref')).toThrow(VaultCryptoError);
  });
});
