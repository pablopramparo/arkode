import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { migrationsSourceDir } from '../../src/paths.js';
import { DEFAULT_SCRYPT_PARAMS } from '../../src/vault/crypto.js';
import { createVaultMetaRepo } from '../../src/vault/vaultMetaRepo.js';
import { createVaultState } from '../../src/vault/vaultState.js';
import { createVaultSecretStore } from '../../src/vault/vaultSecretStore.js';
import {
  newCredentialSecretRef,
  normalizeCredentialSecret,
  readCredentialSecret,
  writeCredentialSecret,
} from '../../src/vault/credentialBlob.js';

const FAST = { ...DEFAULT_SCRYPT_PARAMS, N: 2 ** 12 };

describe('normalizeCredentialSecret', () => {
  it('keeps known non-empty fields and drops blanks / unknown keys', () => {
    expect(
      normalizeCredentialSecret({ password: 'p', token: '', junk: 'x', notes: 'n' })
    ).toEqual({ password: 'p', notes: 'n' });
  });

  it('keeps a PEM private key and its passphrase', () => {
    const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n';
    expect(normalizeCredentialSecret({ privateKey: pem, privateKeyPassphrase: 'pp' })).toEqual({
      privateKey: pem,
      privateKeyPassphrase: 'pp',
    });
  });

  it('keeps non-empty custom entries only', () => {
    expect(normalizeCredentialSecret({ custom: { a: '1', b: '', c: '3' } })).toEqual({ custom: { a: '1', c: '3' } });
  });

  it('returns undefined when nothing usable is left', () => {
    expect(normalizeCredentialSecret({ password: '', custom: { a: '' } })).toBeUndefined();
    expect(normalizeCredentialSecret(null)).toBeUndefined();
    expect(normalizeCredentialSecret('nope')).toBeUndefined();
  });
});

describe('write/readCredentialSecret round trip', () => {
  function setup() {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, migrationsSourceDir());
    const vaultState = createVaultState({ vaultMetaRepo: createVaultMetaRepo(db), autoLockMs: null });
    vaultState.init('master', FAST);
    return { store: createVaultSecretStore(db, vaultState), vaultState };
  }

  it('round-trips a full secret object', () => {
    const { store } = setup();
    const ref = newCredentialSecretRef();
    const secret = {
      password: 'hunter2',
      token: 'ghp_abc',
      privateKey: '-----BEGIN KEY-----\nx\n-----END KEY-----\n',
      custom: { region: 'us-east-1' },
      notes: 'careful with prod',
    };
    writeCredentialSecret(store, ref, secret);
    expect(readCredentialSecret(store, ref)).toEqual(secret);
  });

  it('returns {} for an absent ref', () => {
    const { store } = setup();
    expect(readCredentialSecret(store, 'vault:credential:missing')).toEqual({});
  });

  it('refs look like vault:credential:<uuid>', () => {
    expect(newCredentialSecretRef()).toMatch(/^vault:credential:[0-9a-f-]{36}$/);
  });
});
