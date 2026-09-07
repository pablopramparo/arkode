import { describe, expect, it } from 'vitest';
import { validatePocketSnapshotPayload } from 'pocket-shared';
import { createTestContext } from '../../helpers/testContext.js';
import { buildPocketSnapshotPayload } from '../../../src/vault/pocket/pocketSnapshot.js';
import { newCredentialSecretRef, writeCredentialSecret } from '../../../src/vault/credentialBlob.js';

function unlockedVault(ctx: ReturnType<typeof createTestContext>) {
  ctx.vaultState.init('master-password-test-only');
}

describe('buildPocketSnapshotPayload', () => {
  it('includes an active client, its credential (with decrypted secret), and its URL', () => {
    const ctx = createTestContext();
    unlockedVault(ctx);
    const client = ctx.clientsRepo.create({ name: 'Rivera', localBasePath: 'D:/Backups/Rivera' });
    const cred = ctx.vaultCredentialsRepo.create({
      clientId: client.id,
      name: 'MySQL Production',
      kind: 'mysql',
      host: 'db.rivera.test',
      username: 'demo',
    });
    const ref = newCredentialSecretRef();
    writeCredentialSecret(ctx.vaultSecretStore, ref, { password: 'correct-horse-test-only' });
    ctx.vaultCredentialsRepo.setSecretBlobRef(cred.id, ref);
    ctx.vaultUrlsRepo.create({ clientId: client.id, name: 'Admin', url: 'https://rivera.test/admin' });

    const payload = buildPocketSnapshotPayload(ctx);

    expect(payload.clients).toEqual([{ id: client.id, name: 'Rivera' }]);
    expect(payload.credentials).toHaveLength(1);
    expect(payload.credentials[0].host).toBe('db.rivera.test');
    expect(payload.credentials[0].secret.password).toBe('correct-horse-test-only');
    expect(payload.urls).toHaveLength(1);
    expect(payload.urls[0].url).toBe('https://rivera.test/admin');

    // and it passes pocket-shared's own strict validator unchanged
    expect(validatePocketSnapshotPayload(payload)).toEqual(payload);
  });

  it('excludes a deactivated client and everything under it', () => {
    const ctx = createTestContext();
    unlockedVault(ctx);
    const client = ctx.clientsRepo.create({ name: 'Old Client', localBasePath: 'D:/Backups/Old' });
    ctx.vaultCredentialsRepo.create({ clientId: client.id, name: 'Legacy DB', kind: 'postgres' });
    ctx.vaultUrlsRepo.create({ clientId: client.id, name: 'Legacy panel', url: 'https://old.test' });
    ctx.clientsRepo.deactivate(client.id);

    const payload = buildPocketSnapshotPayload(ctx);
    expect(payload.clients).toHaveLength(0);
    expect(payload.credentials).toHaveLength(0);
    expect(payload.urls).toHaveLength(0);
  });

  it('a credential with no secret blob yet gets an empty secret object, not a crash', () => {
    const ctx = createTestContext();
    unlockedVault(ctx);
    const client = ctx.clientsRepo.create({ name: 'Rivera', localBasePath: 'D:/Backups/Rivera' });
    ctx.vaultCredentialsRepo.create({ clientId: client.id, name: 'No secret yet', kind: 'generic_login' });

    const payload = buildPocketSnapshotPayload(ctx);
    expect(payload.credentials[0].secret).toEqual({});
  });

  it('never includes anything beyond clients/credentials/urls (out-of-scope domains simply are never read)', () => {
    const ctx = createTestContext();
    unlockedVault(ctx);
    const client = ctx.clientsRepo.create({ name: 'Rivera', localBasePath: 'D:/Backups/Rivera' });
    ctx.vaultItemsRepo.create({ clientId: client.id, type: 'note', title: 'Deploy steps', bodyPlaintext: 'do the thing' });

    const payload = buildPocketSnapshotPayload(ctx);
    expect(Object.keys(payload).sort()).toEqual(['clients', 'credentials', 'formatVersion', 'urls']);
  });
});
