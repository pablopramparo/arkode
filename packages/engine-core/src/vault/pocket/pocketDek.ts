import { generatePocketDek as sharedGeneratePocketDek } from 'pocket-shared';
import { nodePocketCryptoAdapter } from 'pocket-shared/node';
import type { SecretStore } from '../../secrets/types.js';

/**
 * Where the Pocket DEK lives on Desktop: Tier-1 DPAPI (LocalMachine scope,
 * `MachineDpapiSecretStore`) — the exact same mechanism every other
 * operational secret in this app already uses (rclone tokens, restic
 * recovery keys, transport passphrases). Deliberately NOT Tier-2 (the
 * master-password-gated vault): the Pocket DEK must be readable to build a
 * snapshot whenever the vault is unlocked, and it is not itself derived
 * from or protected by the master password — see pocket-shared's crypto.ts
 * header comment for why Pocket has its own, simpler, independent key.
 */
export const POCKET_DEK_SECRET_REF = 'pocket:dek';

export function hasPocketDek(secretStore: SecretStore): boolean {
  return secretStore.get(POCKET_DEK_SECRET_REF) !== null;
}

export function getPocketDek(secretStore: SecretStore): Uint8Array | null {
  const raw = secretStore.get(POCKET_DEK_SECRET_REF);
  if (!raw) return null;
  return new Uint8Array(Buffer.from(raw, 'base64'));
}

/** Generates a fresh 32-byte Pocket DEK and stores it, OVERWRITING whatever key was there before. */
export function generatePocketDek(secretStore: SecretStore): Uint8Array {
  const dek = sharedGeneratePocketDek(nodePocketCryptoAdapter);
  secretStore.set(POCKET_DEK_SECRET_REF, Buffer.from(dek).toString('base64'));
  return dek;
}

/** Semantically identical to generatePocketDek — named separately for call-site clarity at a revoke. */
export function rotatePocketDek(secretStore: SecretStore): Uint8Array {
  return generatePocketDek(secretStore);
}
