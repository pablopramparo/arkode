import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildPocketSyncFile,
  decryptPocketSnapshotPayload,
  parsePocketSyncFile,
  serializePocketSyncFile,
  POCKET_SYNC_FILE_NAME,
} from 'pocket-shared';
import { nodePocketCryptoAdapter } from 'pocket-shared/node';
import { redactSecrets } from '../../logging/redact.js';
import { rcloneCopyDown, rcloneCopyTo, rcloneDeleteFile, rcloneLsf, rcloneMoveTo, withRcloneConfig } from '../../replication/rcloneClient.js';
import { buildPocketSnapshotPayload, type BuildPocketSnapshotDeps } from './pocketSnapshot.js';
import { getPocketDek } from './pocketDek.js';
import { getPocketDriveConfig } from './pocketDriveAuth.js';
import { withPocketLock } from './pocketPublishLock.js';
import type { SecretStore } from '../../secrets/types.js';
import type { VaultState } from '../vaultState.js';
import type { PocketState, PocketStateRepo } from '../../db/repositories/pocketStateRepo.js';

/** rclone operations this module uses — overridable in tests only (mirrors runVaultBackup.ts's RcloneVaultOps seam). */
export interface RcloneePocketOps {
  withRcloneConfig: typeof withRcloneConfig;
  copyTo: typeof rcloneCopyTo;
  copyDown: typeof rcloneCopyDown;
  moveTo: typeof rcloneMoveTo;
  lsf: typeof rcloneLsf;
  deleteFile: typeof rcloneDeleteFile;
}

export interface RunPocketPublishDeps extends BuildPocketSnapshotDeps {
  pocketStateRepo: PocketStateRepo;
  secretStore: SecretStore;
  vaultState: VaultState;
  /** Test-only injection seam — production never sets this. */
  rcloneOps?: RcloneePocketOps;
}

export type PocketPublishStatus = 'published' | 'skipped_not_dirty' | 'not_configured' | 'disabled' | 'failed';

export interface PocketPublishResult {
  status: PocketPublishStatus;
  revision?: number;
  error?: string;
  state: PocketState | null;
}

const TEMP_FILE_SUFFIX = '.uploading';

function defaultOps(): RcloneePocketOps {
  return { withRcloneConfig, copyTo: rcloneCopyTo, copyDown: rcloneCopyDown, moveTo: rcloneMoveTo, lsf: rcloneLsf, deleteFile: rcloneDeleteFile };
}

/**
 * Publishes a fresh Pocket snapshot to Google Drive, IF Pocket is
 * configured+enabled and (dirty OR `force`). Never throws — every failure
 * is folded into `pocket_state.last_error` and the returned result.
 *
 * Upload safety: rclone's plain `copyto` straight onto the final filename
 * is not treated as good enough on its own. Google Drive's own resumable
 * upload commits content atomically per request (a dropped connection
 * cannot leave the existing file half-overwritten), but that is Drive's
 * honesty, not a guarantee this code controls — so instead: upload to a
 * TEMPORARY remote name, download it back down and fully decrypt+validate
 * it locally (the strongest possible check — not just a size/hash
 * comparison), and only THEN `moveto` the temp name over the real file
 * name. For the Drive backend, `moveto` is a metadata-only rename
 * (`files.update` with a new name — no re-upload), which is the closest
 * thing Drive's API offers to a real atomic replace. `lastConfirmedRevision`
 * is only advanced after that rename succeeds — a failure at ANY step
 * before it leaves the previously-published file completely untouched.
 */
export function runPocketPublish(deps: RunPocketPublishDeps, opts: { force?: boolean } = {}): Promise<PocketPublishResult> {
  return withPocketLock(() => doPublish(deps, opts));
}

async function doPublish(deps: RunPocketPublishDeps, opts: { force?: boolean }): Promise<PocketPublishResult> {
  const state = deps.pocketStateRepo.get();
  if (!state || !state.configured) return { status: 'not_configured', state: null };
  if (!state.enabled) return { status: 'disabled', state };
  if (!state.dirty && !opts.force) return { status: 'skipped_not_dirty', state };

  if (!deps.vaultState.isUnlocked()) {
    const message = 'The vault is locked — unlock Arkode to publish Pocket.';
    deps.pocketStateRepo.recordFailure(message);
    return { status: 'failed', error: message, state: deps.pocketStateRepo.get() };
  }

  const dek = getPocketDek(deps.secretStore);
  if (!dek) {
    const message = 'Arkode Pocket has no device key yet — pair a device first.';
    deps.pocketStateRepo.recordFailure(message);
    return { status: 'failed', error: message, state: deps.pocketStateRepo.get() };
  }

  const drive = getPocketDriveConfig(deps.secretStore);
  if (!drive || !state.driveRemotePath) {
    const message = 'Google Drive is not connected for Arkode Pocket.';
    deps.pocketStateRepo.recordFailure(message);
    return { status: 'failed', error: message, state: deps.pocketStateRepo.get() };
  }

  const ops = deps.rcloneOps ?? defaultOps();
  const { targetSeq, targetRevision } = deps.pocketStateRepo.beginPublishAttempt();

  try {
    const payload = buildPocketSnapshotPayload(deps);
    const generatedAt = new Date().toISOString();
    const file = buildPocketSyncFile(
      payload,
      dek,
      { pocketId: state.pocketId, revision: targetRevision, generatedAt },
      nodePocketCryptoAdapter
    );
    const bytes = serializePocketSyncFile(file);

    // Local self-check before anything is uploaded (cheap, catches a logic bug immediately).
    decryptPocketSnapshotPayload(parsePocketSyncFile(bytes), dek, nodePocketCryptoAdapter);

    const tempName = `${POCKET_SYNC_FILE_NAME}${TEMP_FILE_SUFFIX}-${randomUUID().slice(0, 8)}`;
    const stagingDir = await mkdtemp(join(tmpdir(), 'arkode-pocket-'));
    try {
      const stagedPath = join(stagingDir, tempName);
      await writeFile(stagedPath, bytes);

      await ops.withRcloneConfig({ encryptWithCrypt: false }, { provider: 'rclone_drive', drive }, undefined, async (configPath, remoteSection) => {
        // 1. upload to a throwaway remote name
        await ops.copyTo({ configPath, remoteSection, localFile: stagedPath, remoteFile: `${state.driveRemotePath}/${tempName}` });

        // 2. download it back and fully decrypt+validate — the strongest
        //    possible proof the bytes that actually landed on Drive are correct,
        //    not just that our local upload call returned without error.
        const verifyDir = join(stagingDir, 'verify');
        await ops.copyDown({ configPath, remoteSection, remotePath: `${state.driveRemotePath}/${tempName}`, destDir: verifyDir });
        const downloaded = await readFile(join(verifyDir, tempName));
        decryptPocketSnapshotPayload(parsePocketSyncFile(downloaded), dek, nodePocketCryptoAdapter);

        // 3. only now "commit": rename the verified temp file over the real one.
        await ops.moveTo({ configPath, remoteSection, sourceFile: `${state.driveRemotePath}/${tempName}`, destFile: `${state.driveRemotePath}/${POCKET_SYNC_FILE_NAME}` });

        // 4. best-effort: resolve the (possibly new) Drive file id for future pairing QRs, and sweep any orphaned temp files from a prior crashed attempt.
        try {
          const ids = await ops.lsf({ configPath, remoteSection, remotePath: state.driveRemotePath!, include: POCKET_SYNC_FILE_NAME, format: 'i' });
          if (ids[0]) deps.pocketStateRepo.setDriveFileId(ids[0]);
        } catch {
          /* discovery-hint only, never fails the publish */
        }
        try {
          const leftovers = await ops.lsf({ configPath, remoteSection, remotePath: state.driveRemotePath!, include: `${POCKET_SYNC_FILE_NAME}${TEMP_FILE_SUFFIX}-*` });
          for (const name of leftovers) {
            await ops.deleteFile({ configPath, remoteSection, remoteFile: `${state.driveRemotePath}/${name}` }).catch(() => {});
          }
        } catch {
          /* best-effort cleanup only */
        }
      });
    } finally {
      await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    }

    const newState = deps.pocketStateRepo.confirmPublish(targetSeq, targetRevision);
    return { status: 'published', revision: targetRevision, state: newState };
  } catch (err) {
    const message = redactSecrets(err instanceof Error ? err.message : String(err));
    deps.pocketStateRepo.recordFailure(message);
    return { status: 'failed', error: message, state: deps.pocketStateRepo.get() };
  }
}
