import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decryptPocketSnapshotPayload, parsePocketSyncFile, POCKET_SYNC_FILE_NAME } from 'pocket-shared';
import { nodePocketCryptoAdapter } from 'pocket-shared/node';
import { createTestContext } from '../../helpers/testContext.js';
import { runPocketPublish, type RcloneePocketOps } from '../../../src/vault/pocket/runPocketPublish.js';
import { generatePocketDek, getPocketDek, hasPocketDek } from '../../../src/vault/pocket/pocketDek.js';
import { setPocketDriveToken } from '../../../src/vault/pocket/pocketDriveAuth.js';

/** Minimal glob: exact match, or a `prefix*` pattern. Enough for the two include patterns runPocketPublish.ts uses. */
function globMatch(name: string, pattern: string): boolean {
  if (!pattern.includes('*')) return name === pattern;
  const prefix = pattern.slice(0, pattern.indexOf('*'));
  return name.startsWith(prefix);
}

/** An in-memory fake of the Drive remote — no real rclone.exe, no real network. */
function createFakeRemote(opts: { failCopyTo?: boolean; corruptOnDownload?: boolean } = {}) {
  const files = new Map<string, Buffer>();
  let copyToCalls = 0;
  const ops: RcloneePocketOps = {
    async withRcloneConfig(_target, _remote, _cryptPw, fn) {
      return fn('fake-config-path', 'fake-remote');
    },
    async copyTo({ localFile, remoteFile }) {
      copyToCalls++;
      if (opts.failCopyTo) throw new Error('rclone copyto failed: simulated network error');
      files.set(remoteFile, await readFile(localFile));
    },
    async copyDown({ remotePath, destDir }) {
      const buf = files.get(remotePath);
      if (!buf) throw new Error('directory not found');
      await mkdir(destDir, { recursive: true });
      const name = remotePath.split('/').pop()!;
      const bytes = opts.corruptOnDownload ? Buffer.concat([buf, Buffer.from('corruption')]) : buf;
      await writeFile(join(destDir, name), bytes);
    },
    async moveTo({ sourceFile, destFile }) {
      const buf = files.get(sourceFile);
      if (!buf) throw new Error('rclone moveto failed: source not found');
      files.set(destFile, buf);
      files.delete(sourceFile);
    },
    async lsf({ remotePath, include, format }) {
      const prefix = `${remotePath}/`;
      const names = Array.from(files.keys())
        .filter((k) => k.startsWith(prefix))
        .map((k) => k.slice(prefix.length));
      const matched = include ? names.filter((n) => globMatch(n, include)) : names;
      return format === 'i' ? matched.map((n) => `fake-drive-id-${n}`) : matched;
    },
    async deleteFile({ remoteFile }) {
      files.delete(remoteFile);
    },
  };
  return { files, ops, callCount: () => copyToCalls };
}

function setup() {
  const ctx = createTestContext();
  ctx.vaultState.init('master-password-test-only');
  const client = ctx.clientsRepo.create({ name: 'Rivera', localBasePath: 'D:/Backups/Rivera' });
  ctx.vaultCredentialsRepo.create({ clientId: client.id, name: 'MySQL', kind: 'mysql', host: 'db.rivera.test' });
  return ctx;
}

function configureAndPair(ctx: ReturnType<typeof setup>) {
  ctx.pocketStateRepo.configure({ driveRemotePath: 'Arkode/Pocket' });
  setPocketDriveToken(ctx.secretStore, JSON.stringify({ token: '{"access_token":"fake"}' }));
  // Pocket configure() already generates the DEK on first configure — see
  // pocketSetup.ts, but this test calls the repo directly, so mint one the
  // same way configurePocket() would.
  if (!hasPocketDek(ctx.secretStore)) generatePocketDek(ctx.secretStore);
}

describe('runPocketPublish', () => {
  it('publishes revision 1 end-to-end: encrypted on Drive, decryptable, dirty cleared', async () => {
    const ctx = setup();
    configureAndPair(ctx);
    const { ops, files } = createFakeRemote();

    const result = await runPocketPublish({ ...ctx, rcloneOps: ops });

    expect(result.status).toBe('published');
    expect(result.revision).toBe(1);
    expect(result.state?.dirty).toBe(false);
    expect(result.state?.lastConfirmedRevision).toBe(1);

    const finalBytes = files.get('Arkode/Pocket/' + POCKET_SYNC_FILE_NAME);
    expect(finalBytes).toBeDefined();
    // no plaintext of the real host anywhere in the uploaded bytes
    expect(finalBytes!.toString('utf8')).not.toContain('db.rivera.test');

    const dek = getPocketDek(ctx.secretStore)!;
    const decrypted = decryptPocketSnapshotPayload(parsePocketSyncFile(finalBytes!), dek, nodePocketCryptoAdapter);
    expect(decrypted.credentials[0].host).toBe('db.rivera.test');

    // no leftover temp/uploading files after a successful publish
    const leftovers = Array.from(files.keys()).filter((k) => k.includes('.uploading-'));
    expect(leftovers).toHaveLength(0);
  });

  it('is a no-op when not dirty and not forced', async () => {
    const ctx = setup();
    configureAndPair(ctx);
    const { ops } = createFakeRemote();
    await runPocketPublish({ ...ctx, rcloneOps: ops });
    const second = await runPocketPublish({ ...ctx, rcloneOps: ops });
    expect(second.status).toBe('skipped_not_dirty');
    expect(second.state?.lastConfirmedRevision).toBe(1);
  });

  it('force republishes even when not dirty, without bumping the revision number', async () => {
    const ctx = setup();
    configureAndPair(ctx);
    const { ops } = createFakeRemote();
    await runPocketPublish({ ...ctx, rcloneOps: ops });
    const forced = await runPocketPublish({ ...ctx, rcloneOps: ops }, { force: true });
    expect(forced.status).toBe('published');
    expect(forced.revision).toBe(2); // still a real new publish attempt, next revision — force skips the dirty GATE, not revision math
  });

  it('reports not_configured before configurePocket() has ever run', async () => {
    const ctx = createTestContext();
    const { ops } = createFakeRemote();
    const result = await runPocketPublish({ ...ctx, rcloneOps: ops });
    expect(result.status).toBe('not_configured');
  });

  it('fails cleanly (no throw) when the vault is locked, and never touches Drive', async () => {
    const ctx = setup();
    configureAndPair(ctx);
    ctx.vaultState.lock();
    const { ops, callCount } = createFakeRemote();

    const result = await runPocketPublish({ ...ctx, rcloneOps: ops });
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/vault is locked/i);
    expect(callCount()).toBe(0);
    expect(result.state?.lastConfirmedRevision).toBeNull();
  });

  it('a failed upload never confirms the revision and leaves the previous published file untouched', async () => {
    const ctx = setup();
    configureAndPair(ctx);
    const good = createFakeRemote();
    await runPocketPublish({ ...ctx, rcloneOps: good.ops }); // revision 1, real success
    const before = good.files.get('Arkode/Pocket/' + POCKET_SYNC_FILE_NAME);

    // dirty it again, then simulate the retry's upload failing
    const client2 = ctx.clientsRepo.listActive()[0];
    ctx.vaultCredentialsRepo.create({ clientId: client2.id, name: 'Second cred', kind: 'generic_secret' });
    const failing = createFakeRemote({ failCopyTo: true });
    failing.files.set('Arkode/Pocket/' + POCKET_SYNC_FILE_NAME, before!); // same starting remote state

    const result = await runPocketPublish({ ...ctx, rcloneOps: failing.ops });
    expect(result.status).toBe('failed');
    expect(result.state?.lastConfirmedRevision).toBe(1); // still 1, NOT bumped
    expect(result.state?.dirty).toBe(true); // correctly still pending
    expect(failing.files.get('Arkode/Pocket/' + POCKET_SYNC_FILE_NAME)).toEqual(before); // untouched
  });

  it('a corrupted download during the verify step fails the publish and never renames the temp file into place', async () => {
    const ctx = setup();
    configureAndPair(ctx);
    const remote = createFakeRemote({ corruptOnDownload: true });

    const result = await runPocketPublish({ ...ctx, rcloneOps: remote.ops });
    expect(result.status).toBe('failed');
    expect(remote.files.has('Arkode/Pocket/' + POCKET_SYNC_FILE_NAME)).toBe(false); // never committed
  });

  it('errors are redacted (never leak the Drive token or Pocket DEK)', async () => {
    const ctx = setup();
    configureAndPair(ctx);
    const dekBase64 = Buffer.from(getPocketDek(ctx.secretStore)!).toString('base64');
    const remote = createFakeRemote({ failCopyTo: true });

    const result = await runPocketPublish({ ...ctx, rcloneOps: remote.ops });
    expect(result.status).toBe('failed');
    expect(result.error).not.toContain(dekBase64);
    expect(result.error).not.toContain('access_token');
  });

  it('two concurrent publish calls never produce two different confirmed revisions for the same content', async () => {
    const ctx = setup();
    configureAndPair(ctx);
    const { ops } = createFakeRemote();

    const [a, b] = await Promise.all([runPocketPublish({ ...ctx, rcloneOps: ops }), runPocketPublish({ ...ctx, rcloneOps: ops })]);
    const revisions = [a, b].filter((r) => r.status === 'published').map((r) => r.revision);
    expect(revisions).toEqual([1]); // only the first actually published; the second saw "not dirty" once serialized behind it
    expect(ctx.pocketStateRepo.get()!.lastConfirmedRevision).toBe(1);
  });
});
