import { describe, expect, it, beforeEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestContext, type TestContext } from '../helpers/testContext.js';
import {
  applyOperationalCopy,
  resyncOperationalCopies,
  syncOperationalCopy,
  type SyncOperationalCopyDeps,
} from '../../src/vault/syncOperationalCopy.js';
import { DEFAULT_SCRYPT_PARAMS } from '../../src/vault/crypto.js';
import { readCredentialSecret, writeCredentialSecret, newCredentialSecretRef } from '../../src/vault/credentialBlob.js';

const FAST = { ...DEFAULT_SCRYPT_PARAMS, N: 2 ** 12 };
const PEM = '-----BEGIN OPENSSH PRIVATE KEY-----\nZmFrZQ==\n-----END OPENSSH PRIVATE KEY-----\n';

function makeDeps(ctx: TestContext, keysDirOverride: string, overrides: Partial<SyncOperationalCopyDeps> = {}): SyncOperationalCopyDeps {
  return {
    db: ctx.db,
    vaultCredentialsRepo: ctx.vaultCredentialsRepo,
    vaultSecretStore: ctx.vaultSecretStore,
    transportsRepo: ctx.transportsRepo,
    databaseConnectionsRepo: ctx.databaseConnectionsRepo,
    secretStore: ctx.secretStore,
    keysDirOverride,
    hardenKeyFile: () => {},
    ...overrides,
  };
}

describe('syncOperationalCopy — happy paths', () => {
  let ctx: TestContext;
  let clientId: string;
  let keysDir: string;

  beforeEach(() => {
    ctx = createTestContext();
    ctx.vaultState.init('master', FAST);
    clientId = ctx.clientsRepo.create({ name: 'Rivera', localBasePath: 'D:\\B\\R' }).id;
    keysDir = mkdtempSync(join(tmpdir(), 'arkode-keys-'));
  });

  it('links a mysql credential: creates a db connection + Tier-1 password + link + state ok', () => {
    const cred = ctx.vaultCredentialsRepo.create({
      clientId,
      name: 'Rivera MySQL',
      kind: 'mysql',
      host: 'db.rivera.com',
      port: 3306,
      username: 'backup',
      databaseName: 'rivera_web',
      secretBlobRef: newCredentialSecretRef(),
    });
    writeCredentialSecret(ctx.vaultSecretStore, cred.secretBlobRef!, { password: 's3cr3t' });

    const result = syncOperationalCopy(makeDeps(ctx, keysDir), cred.id, { useForBackups: true });
    expect(result).toEqual({ ok: true, state: 'ok' });

    const linked = ctx.vaultCredentialsRepo.getById(cred.id)!;
    expect(linked.operationalSyncState).toBe('ok');
    expect(linked.linkedDatabaseConnectionId).toBeTruthy();

    const conn = ctx.databaseConnectionsRepo.getById(linked.linkedDatabaseConnectionId!)!;
    expect(conn.host).toBe('db.rivera.com');
    expect(conn.passwordSecretRef).toBeTruthy();
    expect(ctx.secretStore.get(conn.passwordSecretRef!)).toBe('s3cr3t');
  });

  it('links an ssh credential: materialises a real key file + Tier-1 passphrase + link', () => {
    const cred = ctx.vaultCredentialsRepo.create({
      clientId,
      name: 'Rivera VPS',
      kind: 'ssh',
      host: 'vps.rivera.com',
      port: 22,
      username: 'arkode-backup',
      secretBlobRef: newCredentialSecretRef(),
    });
    writeCredentialSecret(ctx.vaultSecretStore, cred.secretBlobRef!, { privateKey: PEM, privateKeyPassphrase: 'pp' });

    const result = syncOperationalCopy(makeDeps(ctx, keysDir), cred.id, { useForBackups: true });
    expect(result.ok).toBe(true);

    const linked = ctx.vaultCredentialsRepo.getById(cred.id)!;
    const transport = ctx.transportsRepo.getById(linked.linkedTransportId!)!;
    expect(transport.type).toBe('ssh');
    expect(transport.privateKeyPath).toMatch(/\.key$/);
    expect(existsSync(transport.privateKeyPath!)).toBe(true);
    expect(readFileSync(transport.privateKeyPath!, 'utf8')).toBe(PEM);
    expect(ctx.secretStore.get(transport.passphraseSecretRef!)).toBe('pp');
  });

  it('re-linking with a fresh secret updates blob + Tier-1 atomically and retires the old key file', () => {
    const cred = ctx.vaultCredentialsRepo.create({
      clientId, name: 'k', kind: 'ssh', host: 'h', username: 'u', secretBlobRef: newCredentialSecretRef(),
    });
    writeCredentialSecret(ctx.vaultSecretStore, cred.secretBlobRef!, { privateKey: PEM });
    syncOperationalCopy(makeDeps(ctx, keysDir), cred.id, { useForBackups: true });
    const firstKey = ctx.transportsRepo.getById(ctx.vaultCredentialsRepo.getById(cred.id)!.linkedTransportId!)!.privateKeyPath!;

    const NEW_PEM = PEM.replace('ZmFrZQ==', 'bmV3');
    const result = syncOperationalCopy(makeDeps(ctx, keysDir), cred.id, {
      useForBackups: true,
      secret: { privateKey: NEW_PEM, privateKeyPassphrase: 'np' },
    });
    expect(result.ok).toBe(true);

    // blob was re-written with the new plaintext
    expect(readCredentialSecret(ctx.vaultSecretStore, cred.secretBlobRef!).privateKey).toBe(NEW_PEM);
    const newKey = ctx.transportsRepo.getById(ctx.vaultCredentialsRepo.getById(cred.id)!.linkedTransportId!)!.privateKeyPath!;
    expect(readFileSync(newKey, 'utf8')).toBe(NEW_PEM);
    expect(existsSync(firstKey)).toBe(false); // retired
    expect(readdirSync(keysDir).filter((f) => f.endsWith('.key'))).toHaveLength(1);
  });

  it('unlink clears the link + state but keeps the transport row and its DPAPI secret', () => {
    const cred = ctx.vaultCredentialsRepo.create({
      clientId, name: 'k', kind: 'ssh', host: 'h', username: 'u', secretBlobRef: newCredentialSecretRef(),
    });
    writeCredentialSecret(ctx.vaultSecretStore, cred.secretBlobRef!, { privateKey: PEM, privateKeyPassphrase: 'pp' });
    syncOperationalCopy(makeDeps(ctx, keysDir), cred.id, { useForBackups: true });
    const transportId = ctx.vaultCredentialsRepo.getById(cred.id)!.linkedTransportId!;
    const passRef = ctx.transportsRepo.getById(transportId)!.passphraseSecretRef!;

    const result = syncOperationalCopy(makeDeps(ctx, keysDir), cred.id, { useForBackups: false });
    expect(result).toEqual({ ok: true, state: 'none' });

    const after = ctx.vaultCredentialsRepo.getById(cred.id)!;
    expect(after.linkedTransportId).toBeNull();
    expect(after.operationalSyncState).toBe('none');
    // transport + its Tier-1 secret survive so the backup job keeps working
    expect(ctx.transportsRepo.getById(transportId)).not.toBeNull();
    expect(ctx.secretStore.get(passRef)).toBe('pp');
  });
});

describe('syncOperationalCopy — failure injection', () => {
  let ctx: TestContext;
  let clientId: string;
  let keysDir: string;

  beforeEach(() => {
    ctx = createTestContext();
    ctx.vaultState.init('master', FAST);
    clientId = ctx.clientsRepo.create({ name: 'Rivera', localBasePath: 'D:\\B\\R' }).id;
    keysDir = mkdtempSync(join(tmpdir(), 'arkode-keys-'));
  });

  function mysqlCred() {
    const cred = ctx.vaultCredentialsRepo.create({
      clientId, name: 'm', kind: 'mysql', host: 'h', port: 3306, username: 'u', databaseName: 'd',
      secretBlobRef: newCredentialSecretRef(),
    });
    writeCredentialSecret(ctx.vaultSecretStore, cred.secretBlobRef!, { password: 'ORIGINAL' });
    return cred;
  }

  it('a throw in the connection-row create rolls back everything; blob + link + state unchanged', () => {
    const cred = mysqlCred();
    const deps = makeDeps(ctx, keysDir, {
      databaseConnectionsRepo: { ...ctx.databaseConnectionsRepo, create: () => { throw new Error('db create boom'); } },
    });
    const result = syncOperationalCopy(deps, cred.id, { useForBackups: true, secret: { password: 'NEW' } });
    expect(result.ok).toBe(false);
    expect(result.state).toBe('error');
    expect(result.message).toMatch(/boom/);

    const after = ctx.vaultCredentialsRepo.getById(cred.id)!;
    expect(after.linkedDatabaseConnectionId).toBeNull();
    expect(after.operationalSyncState).toBe('error');
    // the blob write was inside the rolled-back transaction — still the original
    expect(readCredentialSecret(ctx.vaultSecretStore, cred.secretBlobRef!).password).toBe('ORIGINAL');
  });

  it('a throw in the Tier-1 DPAPI write rolls back the whole transaction', () => {
    const cred = mysqlCred();
    const realSet = ctx.secretStore.set.bind(ctx.secretStore);
    const deps = makeDeps(ctx, keysDir, {
      secretStore: {
        ...ctx.secretStore,
        set: (ref, value) => {
          if (ref.startsWith('vault-operational:')) throw new Error('dpapi boom');
          realSet(ref, value);
        },
      },
    });
    const result = syncOperationalCopy(deps, cred.id, { useForBackups: true, secret: { password: 'NEW' } });
    expect(result.ok).toBe(false);
    expect(readCredentialSecret(ctx.vaultSecretStore, cred.secretBlobRef!).password).toBe('ORIGINAL');
    expect(ctx.databaseConnectionsRepo.listByClient(clientId)).toHaveLength(0);
  });

  it('a failure materialising the key file leaves nothing committed and no key file behind', () => {
    const cred = ctx.vaultCredentialsRepo.create({
      clientId, name: 'k', kind: 'ssh', host: 'h', username: 'u', secretBlobRef: newCredentialSecretRef(),
    });
    writeCredentialSecret(ctx.vaultSecretStore, cred.secretBlobRef!, { privateKey: PEM });
    const deps = makeDeps(ctx, keysDir, {
      hardenKeyFile: () => { throw new Error('icacls boom'); },
    });
    const result = syncOperationalCopy(deps, cred.id, { useForBackups: true, secret: { privateKey: PEM } });
    expect(result.ok).toBe(false);
    expect(result.state).toBe('error');
    expect(ctx.vaultCredentialsRepo.getById(cred.id)!.linkedTransportId).toBeNull();
    expect(readdirSync(keysDir).filter((f) => f.endsWith('.key') || f.endsWith('.tmp'))).toHaveLength(0);
  });

  it('resyncOperationalCopies rebuilds a wiped Tier-1 secret from the vault (disaster recovery)', () => {
    const good = mysqlCred();
    syncOperationalCopy(makeDeps(ctx, keysDir), good.id, { useForBackups: true });
    const conn = ctx.databaseConnectionsRepo.getById(ctx.vaultCredentialsRepo.getById(good.id)!.linkedDatabaseConnectionId!)!;
    // Simulate a fresh machine: the Tier-1 DPAPI blob is gone.
    ctx.secretStore.delete(conn.passwordSecretRef!);
    expect(ctx.secretStore.get(conn.passwordSecretRef!)).toBeNull();

    const results = resyncOperationalCopies(makeDeps(ctx, keysDir), clientId);
    expect(results).toHaveLength(1);
    expect(results[0].result.ok).toBe(true);
    expect(ctx.secretStore.get(conn.passwordSecretRef!)).toBe('ORIGINAL');
  });

  it('resyncOperationalCopies does not abort the batch when one credential fails', () => {
    const good = mysqlCred();
    syncOperationalCopy(makeDeps(ctx, keysDir), good.id, { useForBackups: true });

    // A linked mysql credential that has since had its host cleared -> its resync fails ("needs host").
    const broken = ctx.vaultCredentialsRepo.create({
      clientId, name: 'brk', kind: 'mysql', host: 'h', port: 3306, username: 'u', databaseName: 'd',
      secretBlobRef: newCredentialSecretRef(),
    });
    writeCredentialSecret(ctx.vaultSecretStore, broken.secretBlobRef!, { password: 'p' });
    syncOperationalCopy(makeDeps(ctx, keysDir), broken.id, { useForBackups: true });
    ctx.vaultCredentialsRepo.update(broken.id, { host: null });

    const results = resyncOperationalCopies(makeDeps(ctx, keysDir), clientId);
    expect(results).toHaveLength(2);
    expect(results.find((r) => r.credentialId === good.id)!.result.ok).toBe(true);
    expect(results.find((r) => r.credentialId === broken.id)!.result.ok).toBe(false);
  });
});
