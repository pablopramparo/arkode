import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  decryptPocketSnapshotPayload,
  parsePocketSyncFile,
  pairingPayloadDek,
  POCKET_SYNC_FILE_NAME,
  PocketCryptoError,
} from 'pocket-shared';
import { nodePocketCryptoAdapter } from 'pocket-shared/node';
import { createTestContext } from '../../helpers/testContext.js';
import { generatePocketPairingPayload, revokePocketDevice } from '../../../src/vault/pocket/pocketPairing.js';
import { runPocketPublish, type RcloneePocketOps } from '../../../src/vault/pocket/runPocketPublish.js';
import { generatePocketDek, getPocketDek, hasPocketDek } from '../../../src/vault/pocket/pocketDek.js';
import { setPocketDriveToken } from '../../../src/vault/pocket/pocketDriveAuth.js';

function setupPaired(ctx: ReturnType<typeof createTestContext>) {
  ctx.vaultState.init('master-password-test-only');
  ctx.pocketStateRepo.configure({ driveRemotePath: 'Arkode/Pocket' });
  setPocketDriveToken(ctx.secretStore, JSON.stringify({ token: '{"access_token":"fake"}' }));
  if (!hasPocketDek(ctx.secretStore)) generatePocketDek(ctx.secretStore);
  return ctx.clientsRepo.create({ name: 'Rivera', localBasePath: 'D:/Backups/Rivera' });
}

describe('generatePocketPairingPayload', () => {
  it('throws if Pocket has not been configured', () => {
    const ctx = createTestContext();
    expect(() => generatePocketPairingPayload(ctx)).toThrow(/has not been configured/);
  });

  it('builds a valid payload carrying the CURRENT Pocket DEK and records a pairing timestamp — never claims the device is connected', () => {
    const ctx = createTestContext();
    setupPaired(ctx);
    const dek = getPocketDek(ctx.secretStore)!;

    const before = ctx.pocketStateRepo.get()!;
    expect(before.pairedAt).toBeNull();

    const payload = generatePocketPairingPayload(ctx, 'Pablo Pixel');
    expect(payload.pocketId).toBe(before.pocketId);
    expect(Buffer.from(pairingPayloadDek(payload)).equals(Buffer.from(dek))).toBe(true);
    expect(payload.drive.remotePath).toBe('Arkode/Pocket');

    const after = ctx.pocketStateRepo.get()!;
    expect(after.pairedAt).not.toBeNull();
    expect(after.deviceLabel).toBe('Pablo Pixel');
    // Generating a QR is not evidence anyone scanned it — see docs/pocket.md.
    // There is deliberately no "connected"/"linked" boolean anywhere on this state.
  });
});

describe('revokePocketDevice', () => {
  it('throws if Pocket has not been configured', async () => {
    const ctx = createTestContext();
    await expect(revokePocketDevice(ctx)).rejects.toThrow(/has not been configured/);
  });

  it('rotates the Pocket DEK so the OLD key can no longer decrypt a snapshot published under the NEW one, and vice versa', async () => {
    const ctx = createTestContext();
    setupPaired(ctx);
    const oldDek = getPocketDek(ctx.secretStore)!;

    await revokePocketDevice(ctx);
    const newDek = getPocketDek(ctx.secretStore)!;
    expect(Buffer.from(newDek).equals(Buffer.from(oldDek))).toBe(false);

    const { buildPocketSyncFile } = await import('pocket-shared');
    const file = buildPocketSyncFile(
      { formatVersion: 1, clients: [], credentials: [], urls: [] },
      newDek,
      { pocketId: 'p', revision: 1, generatedAt: new Date().toISOString() },
      nodePocketCryptoAdapter
    );
    expect(() => decryptPocketSnapshotPayload(file, oldDek, nodePocketCryptoAdapter)).toThrow(PocketCryptoError);
    expect(decryptPocketSnapshotPayload(file, newDek, nodePocketCryptoAdapter)).toEqual({
      formatVersion: 1,
      clients: [],
      credentials: [],
      urls: [],
    });
  });

  it('marks Pocket dirty (forces a republish under the new key) even with zero content changes', async () => {
    const ctx = createTestContext();
    setupPaired(ctx);
    const attempt = ctx.pocketStateRepo.beginPublishAttempt();
    ctx.pocketStateRepo.confirmPublish(attempt.targetSeq, attempt.targetRevision);
    expect(ctx.pocketStateRepo.get()!.dirty).toBe(false);

    await revokePocketDevice(ctx);
    expect(ctx.pocketStateRepo.get()!.dirty).toBe(true);
  });
});

describe('revoke/publish concurrency', () => {
  it('a publish already in flight finishes with the OLD key; a revoke requested during it only takes effect for the NEXT publish', async () => {
    const ctx = setupPairedWithClient();
    const oldDek = getPocketDek(ctx.secretStore)!;

    let releaseUpload: () => void;
    const gate = new Promise<void>((resolve) => (releaseUpload = resolve));
    const files = new Map<string, Buffer>();
    const slowOps: RcloneePocketOps = {
      async withRcloneConfig(_t, _r, _c, fn) {
        await gate; // holds the publish's lock-turn open until we release it below
        return fn('cfg', 'remote');
      },
      async copyTo({ localFile, remoteFile }) {
        files.set(remoteFile, await readFile(localFile));
      },
      async copyDown({ remotePath, destDir }) {
        const buf = files.get(remotePath)!;
        await mkdir(destDir, { recursive: true });
        await writeFile(join(destDir, remotePath.split('/').pop()!), buf);
      },
      async moveTo({ sourceFile, destFile }) {
        files.set(destFile, files.get(sourceFile)!);
        files.delete(sourceFile);
      },
      async lsf() {
        return [];
      },
      async deleteFile() {
        /* noop */
      },
    };

    const publishPromise = runPocketPublish({ ...ctx, rcloneOps: slowOps });
    // Give the publish a tick to actually enter its lock turn before revoke queues behind it.
    await new Promise((r) => setTimeout(r, 0));

    const revokePromise = revokePocketDevice(ctx);
    // Neither has resolved yet — the publish is still waiting on the gate.
    releaseUpload!();

    const [publishResult] = await Promise.all([publishPromise, revokePromise]);

    expect(publishResult.status).toBe('published');
    const uploaded = files.get('Arkode/Pocket/' + POCKET_SYNC_FILE_NAME)!;
    // The completed publish used the OLD key (captured before revoke's turn ran).
    expect(decryptPocketSnapshotPayload(parsePocketSyncFile(uploaded), oldDek, nodePocketCryptoAdapter)).toBeTruthy();
    const newDek = getPocketDek(ctx.secretStore)!;
    expect(() => decryptPocketSnapshotPayload(parsePocketSyncFile(uploaded), newDek, nodePocketCryptoAdapter)).toThrow(PocketCryptoError);

    // And the state is correctly dirty again afterwards — the NEXT publish will use the new key.
    expect(ctx.pocketStateRepo.get()!.dirty).toBe(true);

    function setupPairedWithClient() {
      const context = createTestContext();
      context.vaultState.init('master-password-test-only');
      context.pocketStateRepo.configure({ driveRemotePath: 'Arkode/Pocket' });
      setPocketDriveToken(context.secretStore, JSON.stringify({ token: '{"access_token":"fake"}' }));
      generatePocketDek(context.secretStore);
      context.clientsRepo.create({ name: 'Rivera', localBasePath: 'D:/Backups/Rivera' });
      return context;
    }
  });
});
