import type { VaultAutoUnlockState } from '../vault/autoUnlock.js';
import type { VaultState } from '../vault/vaultState.js';

export interface VaultStatus {
  /** A master password has been set (vault_meta row exists). */
  initialized: boolean;
  /** The DEK is currently held in this process's memory. */
  unlocked: boolean;
  /** ISO timestamp of the next scheduled idle auto-lock, or null (also null when auto-unlock is on). */
  autoLockAt: string | null;
  /**
   * Per-machine auto-unlock state:
   *  - `unsupported`: not available on this OS build
   *  - `disabled`: no local material (the default; a fresh install / restore)
   *  - `enabled`: local DPAPI-CurrentUser-sealed KEK present and usable
   *  - `stale`: material is from a previous master-password epoch (auto-deleted)
   *  - `error`: material is corrupt or from another Windows context (auto-deleted)
   */
  autoUnlock: VaultAutoUnlockState;
  /** ISO timestamp the auto-unlock material was created, when `autoUnlock === 'enabled'`. */
  autoUnlockCreatedAt: string | null;
}

/** Read-only lock/lifecycle snapshot for the UI's "Bóveda" section. Changes nothing. */
export function getVaultStatus(vaultState: VaultState): VaultStatus {
  const au = vaultState.autoUnlockStatus();
  return {
    initialized: vaultState.isInitialized(),
    unlocked: vaultState.isUnlocked(),
    autoLockAt: vaultState.autoLockAt(),
    autoUnlock: au.state,
    autoUnlockCreatedAt: au.createdAt ?? null,
  };
}
