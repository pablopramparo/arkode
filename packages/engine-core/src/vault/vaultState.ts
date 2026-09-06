import {
  DEFAULT_SCRYPT_PARAMS,
  VAULT_FORMAT_VERSION,
  buildVerifier,
  deriveKek,
  generateDek,
  generateSalt,
  unwrapDek,
  verifierMatches,
  wipe,
  wrapDek,
  type ScryptParams,
} from './crypto.js';
import {
  VaultAutoUnlockUnavailableError,
  type VaultAutoUnlock,
  type VaultAutoUnlockStatus,
} from './autoUnlock.js';
import type { VaultMetaRepo } from './vaultMetaRepo.js';

export class VaultLockedError extends Error {
  constructor(message = 'The vault is locked.') {
    super(message);
    this.name = 'VaultLockedError';
  }
}
export class VaultNotInitializedError extends Error {
  constructor(message = 'The vault has not been initialized. Set a master password first.') {
    super(message);
    this.name = 'VaultNotInitializedError';
  }
}
export class VaultAlreadyInitializedError extends Error {
  constructor(message = 'The vault is already initialized.') {
    super(message);
    this.name = 'VaultAlreadyInitializedError';
  }
}
export class WrongMasterPasswordError extends Error {
  constructor(message = 'Wrong master password.') {
    super(message);
    this.name = 'WrongMasterPasswordError';
  }
}

export { VaultAutoUnlockUnavailableError };

export interface VaultStateDeps {
  vaultMetaRepo: VaultMetaRepo;
  /** Idle auto-lock after this many ms of no `touch()`. null/0 disables it. Default 15 min. */
  autoLockMs?: number | null;
  /** Called (best-effort) when the idle timer fires. */
  onAutoLock?: () => void;
  /**
   * OPTIONAL per-machine auto-unlock (DPAPI-CurrentUser-sealed KEK). When
   * present AND enabled: idle auto-lock is suppressed, and `serve` can
   * unlock at startup with no master password. The LocalSystem scheduler
   * must never be given one of these.
   */
  autoUnlock?: VaultAutoUnlock;
  /** Called (best-effort) after an automatic startup auto-unlock — for an audit log line. */
  onAutoUnlocked?: () => void;
  /** Overridable clock, for tests. */
  now?: () => number;
}

export interface VaultState {
  isInitialized(): boolean;
  isUnlocked(): boolean;
  /** Sets the master password for the first time. Leaves the vault UNLOCKED. */
  init(password: string, params?: ScryptParams): void;
  /**
   * Unlock with the master password. `opts.enableAutoUnlock` also seals the
   * KEK for this machine (best-effort — a failure there never fails the unlock).
   */
  unlock(password: string, opts?: { enableAutoUnlock?: boolean }): void;
  lock(): void;
  changePassword(currentPassword: string, newPassword: string, params?: ScryptParams): void;
  /** Runs `fn` with the live DEK. Throws `VaultLockedError` when locked. */
  withDek<T>(fn: (dek: Buffer) => T): T;
  /** ISO timestamp of the next scheduled auto-lock, or null (locked / disabled / auto-unlock on). */
  autoLockAt(): string | null;
  /** Resets the idle auto-lock timer. Call on any authenticated activity. */
  touch(): void;
  setAutoLockMs(ms: number | null): void;

  // --- Per-machine auto-unlock -------------------------------------------
  /** Local sealed-KEK material is present (=> idle auto-lock is suppressed). */
  autoUnlockEnabled(): boolean;
  /** Full auto-unlock status for the UI. */
  autoUnlockStatus(): VaultAutoUnlockStatus;
  /** Seal the KEK for this machine using the master password (verifies it first). */
  enableAutoUnlock(password: string): void;
  /** Delete this machine's sealed-KEK material; idle auto-lock resumes. */
  disableAutoUnlock(): void;
  /**
   * Explicit "unlock with Windows" — recover the DEK via local sealed
   * material, no master password. Allowed even after a manual lock.
   * Throws `VaultAutoUnlockUnavailableError` when there is no usable material.
   */
  unlockWithWindows(): void;
  /**
   * The automatic path: unlock via local material IFF it is enabled and the
   * vault has not been manually locked this process. Silent no-op otherwise.
   * Returns true iff it unlocked. Call once at `serve` startup.
   */
  attemptStartupAutoUnlock(): boolean;
}

const DEFAULT_AUTO_LOCK_MS = 15 * 60 * 1000;

export function createVaultState(deps: VaultStateDeps): VaultState {
  const { vaultMetaRepo, onAutoLock, autoUnlock, onAutoUnlocked } = deps;
  const now = deps.now ?? (() => Date.now());
  let autoLockMs = deps.autoLockMs === undefined ? DEFAULT_AUTO_LOCK_MS : deps.autoLockMs;

  let dek: Buffer | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let autoLockDueAt: number | null = null;
  // Set by lock(); blocks ONLY the automatic startup path. Any explicit
  // unlock (password or "unlock with Windows") clears it.
  let manuallyLocked = false;

  function clearTimer(): void {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    autoLockDueAt = null;
  }

  function autoUnlockOn(): boolean {
    try {
      return autoUnlock?.isEnabled() ?? false;
    } catch {
      return false;
    }
  }

  function armTimer(): void {
    clearTimer();
    // Auto-unlock mode: the Windows session is the perimeter, no idle lock.
    if (autoUnlockOn()) return;
    if (!dek || !autoLockMs || autoLockMs <= 0) return;
    autoLockDueAt = now() + autoLockMs;
    timer = setTimeout(() => {
      lock();
      try {
        onAutoLock?.();
      } catch {
        /* best-effort */
      }
    }, autoLockMs);
    // Do not keep a short-lived CLI process alive just for this.
    (timer as unknown as { unref?: () => void }).unref?.();
  }

  function lock(): void {
    wipe(dek);
    dek = null;
    clearTimer();
    manuallyLocked = true;
  }

  /** Adopt `candidate` as the live DEK. `candidate` ownership passes in. */
  function applyDek(candidate: Buffer): void {
    wipe(dek);
    dek = candidate;
    manuallyLocked = false;
    armTimer();
  }

  /** Shared by unlockWithWindows() and attemptStartupAutoUnlock(). */
  function doUnlockViaWindows(): void {
    const meta = vaultMetaRepo.get();
    if (!meta) throw new VaultNotInitializedError();
    if (!autoUnlock) throw new VaultAutoUnlockUnavailableError();
    const kek = autoUnlock.loadKek(meta.kekSalt);
    if (!kek) throw new VaultAutoUnlockUnavailableError();
    let candidate: Buffer;
    try {
      candidate = unwrapDek(meta.wrappedDek, kek);
    } catch {
      wipe(kek);
      throw new VaultAutoUnlockUnavailableError('Auto-unlock material does not match this vault.');
    }
    wipe(kek);
    if (!verifierMatches(meta.verifier, candidate)) {
      wipe(candidate);
      throw new VaultAutoUnlockUnavailableError('Auto-unlock material does not match this vault.');
    }
    applyDek(candidate);
  }

  return {
    isInitialized() {
      return vaultMetaRepo.get() !== null;
    },
    isUnlocked() {
      return dek !== null;
    },

    init(password, params = DEFAULT_SCRYPT_PARAMS) {
      if (vaultMetaRepo.get() !== null) throw new VaultAlreadyInitializedError();
      if (typeof password !== 'string' || password.length < 1) {
        throw new Error('Master password must be a non-empty string.');
      }
      const salt = generateSalt();
      const kek = deriveKek(password, salt, params);
      const freshDek = generateDek();
      try {
        vaultMetaRepo.create({
          formatVersion: VAULT_FORMAT_VERSION,
          kdf: 'scrypt',
          kdfParams: params,
          kekSalt: salt,
          wrappedDek: wrapDek(freshDek, kek),
          verifier: buildVerifier(freshDek),
        });
      } finally {
        wipe(kek);
      }
      applyDek(freshDek);
    },

    unlock(password, opts) {
      const meta = vaultMetaRepo.get();
      if (!meta) throw new VaultNotInitializedError();
      const kek = deriveKek(password, meta.kekSalt, meta.kdfParams);
      let candidate: Buffer;
      try {
        candidate = unwrapDek(meta.wrappedDek, kek);
      } catch {
        wipe(kek);
        throw new WrongMasterPasswordError();
      }
      if (!verifierMatches(meta.verifier, candidate)) {
        wipe(kek);
        wipe(candidate);
        throw new WrongMasterPasswordError();
      }
      if (opts?.enableAutoUnlock && autoUnlock) {
        // Best-effort: a sealing failure must not fail the unlock. The caller
        // re-reads autoUnlockStatus() to see whether it actually took.
        try {
          autoUnlock.enable(kek, meta.kekSalt);
        } catch {
          /* surfaced via status */
        }
      }
      wipe(kek);
      applyDek(candidate);
    },

    lock,

    changePassword(currentPassword, newPassword, params = DEFAULT_SCRYPT_PARAMS) {
      const meta = vaultMetaRepo.get();
      if (!meta) throw new VaultNotInitializedError();
      if (typeof newPassword !== 'string' || newPassword.length < 1) {
        throw new Error('New master password must be a non-empty string.');
      }
      const currentKek = deriveKek(currentPassword, meta.kekSalt, meta.kdfParams);
      let liveDek: Buffer;
      try {
        liveDek = unwrapDek(meta.wrappedDek, currentKek);
      } catch {
        wipe(currentKek);
        throw new WrongMasterPasswordError();
      }
      wipe(currentKek);
      if (!verifierMatches(meta.verifier, liveDek)) {
        wipe(liveDek);
        throw new WrongMasterPasswordError();
      }
      // Same DEK, fresh salt + KEK — O(1), no secret re-encryption.
      const newSalt = generateSalt();
      const newKek = deriveKek(newPassword, newSalt, params);
      try {
        vaultMetaRepo.updateCrypto({
          kdf: 'scrypt',
          kdfParams: params,
          kekSalt: newSalt,
          wrappedDek: wrapDek(liveDek, newKek),
          verifier: buildVerifier(liveDek),
        });
        // Keep this machine's auto-unlock material valid for the NEW epoch.
        // A failure here just leaves the old file, which the next startup
        // detects as stale (fingerprint mismatch), deletes, and prompts.
        if (autoUnlockOn()) {
          try {
            autoUnlock!.enable(newKek, newSalt);
          } catch {
            /* self-heals on next startup */
          }
        }
      } finally {
        wipe(newKek);
      }
      // Adopt the (unchanged) DEK as the live session key.
      applyDek(liveDek);
    },

    withDek(fn) {
      if (!dek) throw new VaultLockedError();
      armTimer();
      return fn(dek);
    },

    autoLockAt() {
      return autoLockDueAt === null ? null : new Date(autoLockDueAt).toISOString();
    },

    touch() {
      if (dek) armTimer();
    },

    setAutoLockMs(ms) {
      autoLockMs = ms;
      if (dek) armTimer();
    },

    autoUnlockEnabled() {
      return autoUnlockOn();
    },

    autoUnlockStatus() {
      if (!autoUnlock) return { state: 'unsupported' };
      const meta = vaultMetaRepo.get();
      if (!meta) return { state: 'disabled' };
      return autoUnlock.status(meta.kekSalt);
    },

    enableAutoUnlock(password) {
      const meta = vaultMetaRepo.get();
      if (!meta) throw new VaultNotInitializedError();
      if (!autoUnlock) throw new VaultAutoUnlockUnavailableError('Auto-unlock is not available on this system.');
      const kek = deriveKek(password, meta.kekSalt, meta.kdfParams);
      let ok = false;
      try {
        const probe = unwrapDek(meta.wrappedDek, kek);
        ok = verifierMatches(meta.verifier, probe);
        wipe(probe);
      } catch {
        ok = false;
      }
      if (!ok) {
        wipe(kek);
        throw new WrongMasterPasswordError();
      }
      try {
        autoUnlock.enable(kek, meta.kekSalt);
      } finally {
        wipe(kek);
      }
      // Enabling auto-unlock disables idle auto-lock for the running session.
      clearTimer();
    },

    disableAutoUnlock() {
      autoUnlock?.disable();
      // Idle auto-lock behaviour resumes.
      if (dek) armTimer();
    },

    unlockWithWindows() {
      doUnlockViaWindows();
    },

    attemptStartupAutoUnlock() {
      if (dek) return true;
      if (manuallyLocked) return false;
      if (!autoUnlockOn()) return false;
      try {
        doUnlockViaWindows();
        try {
          onAutoUnlocked?.();
        } catch {
          /* best-effort */
        }
        return true;
      } catch {
        return false;
      }
    },
  };
}
