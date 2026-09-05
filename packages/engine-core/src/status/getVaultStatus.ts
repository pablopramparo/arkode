import type { VaultState } from '../vault/vaultState.js';

export interface VaultStatus {
  /** A master password has been set (vault_meta row exists). */
  initialized: boolean;
  /** The DEK is currently held in this process's memory. */
  unlocked: boolean;
  /** ISO timestamp of the next scheduled idle auto-lock, or null. */
  autoLockAt: string | null;
}

/** Read-only lock/lifecycle snapshot for the UI's "Bóveda" section. Changes nothing. */
export function getVaultStatus(vaultState: VaultState): VaultStatus {
  return {
    initialized: vaultState.isInitialized(),
    unlocked: vaultState.isUnlocked(),
    autoLockAt: vaultState.autoLockAt(),
  };
}
