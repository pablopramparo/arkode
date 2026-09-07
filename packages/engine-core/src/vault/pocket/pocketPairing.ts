import { buildPairingPayload, POCKET_SYNC_FILE_NAME, type PocketPairingPayload } from 'pocket-shared';
import { getPocketDek, rotatePocketDek } from './pocketDek.js';
import { withPocketLock } from './pocketPublishLock.js';
import type { SecretStore } from '../../secrets/types.js';
import type { PocketState, PocketStateRepo } from '../../db/repositories/pocketStateRepo.js';

export interface PocketPairingDeps {
  pocketStateRepo: PocketStateRepo;
  secretStore: SecretStore;
}

/**
 * Builds the QR payload for "Vincular dispositivo". Deliberately does NOT
 * mark the device as "paired"/"connected" — Desktop has no way to know
 * whether anyone ever actually scanned it (see docs/pocket.md's "what
 * Desktop can and cannot know" section). It only records that a pairing
 * CODE was generated, at this time, for this optional label — the honest
 * fact, not a claim about the phone's state.
 */
export function generatePocketPairingPayload(deps: PocketPairingDeps, deviceLabel?: string | null): PocketPairingPayload {
  const state = deps.pocketStateRepo.get();
  if (!state || !state.configured) throw new Error('Arkode Pocket has not been configured yet.');
  const dek = getPocketDek(deps.secretStore);
  if (!dek) throw new Error('Arkode Pocket has no device key yet.');

  deps.pocketStateRepo.recordPairing(deviceLabel ?? state.deviceLabel ?? null);

  return buildPairingPayload({
    pocketId: state.pocketId,
    dek,
    drive: {
      fileId: state.driveFileId,
      remotePath: state.driveRemotePath ?? '',
      fileName: POCKET_SYNC_FILE_NAME,
    },
  });
}

/**
 * Revocation, v1 (single device): rotates the Pocket DEK so no snapshot
 * published from now on can be opened by whatever device holds the OLD
 * key, and marks Pocket dirty so the very next publish uses the new key.
 *
 * Concurrency guarantee, precisely: revoke and publish share the same
 * `withPocketLock` queue. Any publish that has not yet STARTED when revoke
 * runs will, once it does start, read the Pocket DEK fresh and therefore
 * get the NEW key — it is impossible for a publish that starts after this
 * function returns to use the old key. A publish that was ALREADY in
 * flight (mid-upload) when revoke was requested will finish using the key
 * it captured at ITS OWN start, before revoke's turn runs — this is treated
 * as correct, not a bug: that request was legitimately authorized before
 * the revoke happened, exactly like an API key revocation not retroactively
 * failing a request already in flight. What this function does NOT do, on
 * purpose (see the caller-facing copy this backs): it does not delete
 * anything the old device already downloaded, does not sign the old device
 * out of Google, and does not touch previously-published Drive history.
 */
export function revokePocketDevice(deps: PocketPairingDeps): Promise<PocketState> {
  return withPocketLock(async () => {
    const state = deps.pocketStateRepo.get();
    if (!state || !state.configured) throw new Error('Arkode Pocket has not been configured yet.');
    rotatePocketDek(deps.secretStore);
    return deps.pocketStateRepo.recordRevocation();
  });
}
