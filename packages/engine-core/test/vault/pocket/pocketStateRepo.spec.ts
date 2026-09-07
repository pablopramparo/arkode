import { describe, expect, it } from 'vitest';
import { createTestContext } from '../../helpers/testContext.js';

/** Publishes+confirms whatever is currently pending, so a following assertion starts from a clean (non-dirty) baseline. */
function publishAndConfirm(ctx: ReturnType<typeof createTestContext>) {
  const attempt = ctx.pocketStateRepo.beginPublishAttempt();
  return ctx.pocketStateRepo.confirmPublish(attempt.targetSeq, attempt.targetRevision);
}

/** Configures Pocket AND clears the "never published yet" dirty flag, so tests can assume a clean baseline. */
function setupConfigured(ctx: ReturnType<typeof createTestContext>) {
  ctx.pocketStateRepo.configure({ driveRemotePath: 'Arkode/Pocket' });
  const client = ctx.clientsRepo.create({ name: 'Rivera', localBasePath: 'D:/Backups/Rivera' });
  publishAndConfirm(ctx);
  return client;
}

describe('pocketStateRepo', () => {
  it('is not configured before configure() is called', () => {
    const ctx = createTestContext();
    expect(ctx.pocketStateRepo.get()).toBeNull();
  });

  it('configure() creates the singleton row, dirty (never published yet), revision null', () => {
    const ctx = createTestContext();
    const state = ctx.pocketStateRepo.configure({ driveRemotePath: 'Arkode/Pocket' });
    expect(state.configured).toBe(true);
    expect(state.enabled).toBe(true);
    // Never published yet == "Pendiente de publicar", not "Al día" — this
    // also correctly covers pre-existing vault data created before Pocket
    // was ever configured (see the migration/repo comment on published_seq).
    expect(state.dirty).toBe(true);
    expect(state.lastConfirmedRevision).toBeNull();
    expect(state.pocketId).toMatch(/[0-9a-f-]{36}/);
  });

  it('configure() again just updates the Drive path, keeps the same pocketId', () => {
    const ctx = createTestContext();
    const first = ctx.pocketStateRepo.configure({ driveRemotePath: 'Arkode/Pocket' });
    const second = ctx.pocketStateRepo.configure({ driveRemotePath: 'Arkode/PocketV2' });
    expect(second.pocketId).toBe(first.pocketId);
    expect(second.driveRemotePath).toBe('Arkode/PocketV2');
  });

  describe('dirty tracking via triggers', () => {
    it('creating a credential marks Pocket dirty', () => {
      const ctx = createTestContext();
      const client = setupConfigured(ctx);
      expect(ctx.pocketStateRepo.get()!.dirty).toBe(false);
      ctx.vaultCredentialsRepo.create({ clientId: client.id, name: 'MySQL', kind: 'mysql' });
      expect(ctx.pocketStateRepo.get()!.dirty).toBe(true);
    });

    it('updating a Pocket-relevant credential field marks dirty', () => {
      const ctx = createTestContext();
      const client = setupConfigured(ctx);
      const cred = ctx.vaultCredentialsRepo.create({ clientId: client.id, name: 'MySQL', kind: 'mysql' });
      publishAndConfirm(ctx);
      expect(ctx.pocketStateRepo.get()!.dirty).toBe(false);

      ctx.vaultCredentialsRepo.update(cred.id, { host: 'db.rivera.test' });
      expect(ctx.pocketStateRepo.get()!.dirty).toBe(true);
    });

    it('deleting a credential marks dirty', () => {
      const ctx = createTestContext();
      const client = setupConfigured(ctx);
      const cred = ctx.vaultCredentialsRepo.create({ clientId: client.id, name: 'MySQL', kind: 'mysql' });
      publishAndConfirm(ctx);
      expect(ctx.pocketStateRepo.get()!.dirty).toBe(false);

      ctx.vaultCredentialsRepo.delete(cred.id);
      expect(ctx.pocketStateRepo.get()!.dirty).toBe(true);
    });

    it('changing a credential SECRET (password) marks dirty even though vault_credentials itself is untouched', () => {
      const ctx = createTestContext();
      ctx.vaultState.init('master-password-test-only');
      const client = setupConfigured(ctx);
      const cred = ctx.vaultCredentialsRepo.create({ clientId: client.id, name: 'MySQL', kind: 'mysql' });
      const ref = 'vault:credential:test-ref';
      ctx.vaultSecretStore.set(ref, JSON.stringify({ password: 'first' }));
      ctx.vaultCredentialsRepo.setSecretBlobRef(cred.id, ref);
      publishAndConfirm(ctx);
      expect(ctx.pocketStateRepo.get()!.dirty).toBe(false);

      // Only the secret changes now — vault_credentials itself is untouched.
      ctx.vaultSecretStore.set(ref, JSON.stringify({ password: 'changed' }));
      expect(ctx.pocketStateRepo.get()!.dirty).toBe(true);
    });

    it('a vault ITEM (note/snippet) secret does NOT dirty Pocket — out of scope', () => {
      const ctx = createTestContext();
      ctx.vaultState.init('master-password-test-only');
      setupConfigured(ctx);
      ctx.vaultSecretStore.set('vault:item:some-note', 'sensitive body text');
      expect(ctx.pocketStateRepo.get()!.dirty).toBe(false);
    });

    it('URL create/update/delete all mark dirty', () => {
      const ctx = createTestContext();
      const client = setupConfigured(ctx);
      const url = ctx.vaultUrlsRepo.create({ clientId: client.id, name: 'Admin', url: 'https://example.test' });
      expect(ctx.pocketStateRepo.get()!.dirty).toBe(true);
      publishAndConfirm(ctx);

      ctx.vaultUrlsRepo.update(url.id, { name: 'Admin panel' });
      expect(ctx.pocketStateRepo.get()!.dirty).toBe(true);
      publishAndConfirm(ctx);

      ctx.vaultUrlsRepo.delete(url.id);
      expect(ctx.pocketStateRepo.get()!.dirty).toBe(true);
    });

    it('renaming a client marks dirty; changing its retention policy does NOT', () => {
      const ctx = createTestContext();
      const client = setupConfigured(ctx);
      publishAndConfirm(ctx);
      expect(ctx.pocketStateRepo.get()!.dirty).toBe(false);

      ctx.clientsRepo.update(client.id, { retentionCount: 5 });
      expect(ctx.pocketStateRepo.get()!.dirty).toBe(false);

      ctx.clientsRepo.update(client.id, { name: 'Rivera Hosting' });
      expect(ctx.pocketStateRepo.get()!.dirty).toBe(true);
    });

    it('deactivating a client marks dirty (it changes snapshot membership)', () => {
      const ctx = createTestContext();
      const client = setupConfigured(ctx);
      publishAndConfirm(ctx);

      ctx.clientsRepo.deactivate(client.id);
      expect(ctx.pocketStateRepo.get()!.dirty).toBe(true);
    });

    it('unrelated domains (backup tasks) never touch pocket_state at all', () => {
      const ctx = createTestContext();
      const client = setupConfigured(ctx);
      const transport = ctx.transportsRepo.createSftp({
        clientId: client.id,
        name: 'sftp',
        host: 'h',
        port: 22,
        username: 'u',
        privateKeyPath: 'C:/key.pem',
        passphraseSecretRef: null,
        knownHostFingerprint: null,
      });
      ctx.tasksRepo.createFetchExisting({
        clientId: client.id,
        transportId: transport.id,
        name: 'task',
        dbEngine: 'postgres',
        remotePath: '/dumps',
        remoteFilePattern: null,
        retentionCount: null,
        retentionDays: null,
      });
      expect(ctx.pocketStateRepo.get()!.dirty).toBe(false);
    });
  });

  describe('revision / concurrency semantics', () => {
    it('beginPublishAttempt allocates confirmedRevision+1 and does not advance it further on retry', () => {
      const ctx = createTestContext();
      ctx.pocketStateRepo.configure({ driveRemotePath: 'Arkode/Pocket' });
      const first = ctx.pocketStateRepo.beginPublishAttempt();
      expect(first.targetRevision).toBe(1);
      ctx.pocketStateRepo.recordFailure('boom');
      const retry = ctx.pocketStateRepo.beginPublishAttempt();
      expect(retry.targetRevision).toBe(1); // same number, not bumped by the failed attempt
    });

    it('confirmPublish advances lastConfirmedRevision and clears dirty when nothing changed meanwhile', () => {
      const ctx = createTestContext();
      ctx.pocketStateRepo.configure({ driveRemotePath: 'Arkode/Pocket' });
      const attempt = ctx.pocketStateRepo.beginPublishAttempt();
      const state = ctx.pocketStateRepo.confirmPublish(attempt.targetSeq, attempt.targetRevision);
      expect(state.lastConfirmedRevision).toBe(1);
      expect(state.dirty).toBe(false);
      expect(state.lastError).toBeNull();
    });

    it('a mutation landing WHILE a publish is in flight keeps dirty=true after confirmPublish (the race case)', () => {
      const ctx = createTestContext();
      ctx.pocketStateRepo.configure({ driveRemotePath: 'Arkode/Pocket' });
      const client = ctx.clientsRepo.create({ name: 'Rivera', localBasePath: 'D:/Backups/Rivera' });
      const attempt = ctx.pocketStateRepo.beginPublishAttempt(); // captures targetSeq BEFORE the mutation below
      ctx.vaultCredentialsRepo.create({ clientId: client.id, name: 'New mid-flight', kind: 'generic_secret' });
      const state = ctx.pocketStateRepo.confirmPublish(attempt.targetSeq, attempt.targetRevision);
      expect(state.lastConfirmedRevision).toBe(1); // that publish WAS confirmed...
      expect(state.dirty).toBe(true); // ...but a newer change is still pending
    });

    it('a second beginPublishAttempt after a mutation mid-flight allocates the NEXT revision, not a repeat', () => {
      const ctx = createTestContext();
      ctx.pocketStateRepo.configure({ driveRemotePath: 'Arkode/Pocket' });
      const client = ctx.clientsRepo.create({ name: 'Rivera', localBasePath: 'D:/Backups/Rivera' });
      const attempt = ctx.pocketStateRepo.beginPublishAttempt();
      ctx.vaultCredentialsRepo.create({ clientId: client.id, name: 'mid-flight', kind: 'generic_secret' });
      ctx.pocketStateRepo.confirmPublish(attempt.targetSeq, attempt.targetRevision);
      const next = ctx.pocketStateRepo.beginPublishAttempt();
      expect(next.targetRevision).toBe(2);
    });

    it('recordFailure leaves dirty/confirmedRevision untouched', () => {
      const ctx = createTestContext();
      ctx.pocketStateRepo.configure({ driveRemotePath: 'Arkode/Pocket' });
      const client = ctx.clientsRepo.create({ name: 'Rivera', localBasePath: 'D:/Backups/Rivera' });
      ctx.vaultCredentialsRepo.create({ clientId: client.id, name: 'x', kind: 'generic_secret' });
      ctx.pocketStateRepo.beginPublishAttempt();
      ctx.pocketStateRepo.recordFailure('Drive is unreachable');
      const state = ctx.pocketStateRepo.get()!;
      expect(state.dirty).toBe(true);
      expect(state.lastConfirmedRevision).toBeNull();
      expect(state.lastError).toBe('Drive is unreachable');
    });

    it('recordRevocation forces dirty even with zero content changes', () => {
      const ctx = createTestContext();
      setupConfigured(ctx);
      publishAndConfirm(ctx);
      expect(ctx.pocketStateRepo.get()!.dirty).toBe(false);

      const revoked = ctx.pocketStateRepo.recordRevocation();
      expect(revoked.dirty).toBe(true);
      expect(revoked.revokedAt).not.toBeNull();
    });
  });
});
