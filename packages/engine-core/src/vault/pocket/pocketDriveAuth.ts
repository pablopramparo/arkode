import type { SecretStore } from '../../secrets/types.js';
import type { RcloneDriveConfig } from '../../replication/types.js';

/**
 * Pocket's OWN Google Drive account connection (Tier-1 DPAPI, same
 * `RcloneDriveConfig` JSON shape replication/vault-backup targets already
 * use). Deliberately a separate ref from either of those — Pocket is its
 * own opt-in destination — but the UI offers "reuse an already-connected
 * account" (copying the token, same as `DriveAuthControls.tsx` already does
 * elsewhere) so the user is not forced through a second OAuth consent just
 * to reuse the same Google account. Desktop's publish path (runPocketPublish.ts)
 * is 100% built on the EXISTING rclone/replication plumbing — no new Drive
 * integration code, just a new secret ref and a new remote folder.
 */
export const POCKET_RCLONE_CONFIG_SECRET_REF = 'pocket:rclone-config';

export function isPocketDriveConnected(secretStore: SecretStore): boolean {
  return secretStore.get(POCKET_RCLONE_CONFIG_SECRET_REF) !== null;
}

export function getPocketDriveConfig(secretStore: SecretStore): RcloneDriveConfig | null {
  const raw = secretStore.get(POCKET_RCLONE_CONFIG_SECRET_REF);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as RcloneDriveConfig;
  } catch {
    return null;
  }
}

/** Stores a freshly-authorized (or pasted) rclone OAuth token JSON as Pocket's own Drive account. */
export function setPocketDriveToken(secretStore: SecretStore, tokenJson: string): void {
  JSON.parse(tokenJson); // fail fast on garbage input rather than storing it
  secretStore.set(POCKET_RCLONE_CONFIG_SECRET_REF, tokenJson);
}

/** Copies an already-connected account's token (e.g. from a replication target or vault-backup target) into Pocket's own ref. */
export function reusePocketDriveTokenFrom(secretStore: SecretStore, sourceSecretRef: string): void {
  const raw = secretStore.get(sourceSecretRef);
  if (!raw) throw new Error('That Google Drive account is not connected yet.');
  secretStore.set(POCKET_RCLONE_CONFIG_SECRET_REF, raw);
}

export function disconnectPocketDrive(secretStore: SecretStore): void {
  secretStore.delete(POCKET_RCLONE_CONFIG_SECRET_REF);
}
