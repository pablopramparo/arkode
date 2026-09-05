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

export interface VaultStateDeps {
  vaultMetaRepo: VaultMetaRepo;
  /** Idle auto-lock after this many ms of no `touch()`. null/0 disables it. Default 15 min. */
  autoLockMs?: number | null;
  /** Called (best-effort) when the idle timer fires. */
  onAutoLock?: () => void;
  /** Overridable clock, for tests. */
  now?: () => number;
}

export interface VaultState {
  isInitialized(): boolean;
  isUnlocked(): boolean;
  /** Sets the master password for the first time. Leaves the vault UNLOCKED. */
  init(password: string, params?: ScryptParams): void;
  unlock(password: string): void;
  lock(): void;
  changePassword(currentPassword: string, newPassword: string, params?: ScryptParams): void;
  /** Runs `fn` with the live DEK. Throws `VaultLockedError` when locked. */
  withDek<T>(fn: (dek: Buffer) => T): T;
  /** ISO timestamp of the next scheduled auto-lock, or null (locked / disabled). */
  autoLockAt(): string | null;
  /** Resets the idle auto-lock timer. Call on any authenticated activity. */
  touch(): void;
  setAutoLockMs(ms: number | null): void;
}

const DEFAULT_AUTO_LOCK_MS = 15 * 60 * 1000;

export function createVaultState(deps: VaultStateDeps): VaultState {
  const { vaultMetaRepo, onAutoLock } = deps;
  const now = deps.now ?? (() => Date.now());
  let autoLockMs = deps.autoLockMs === undefined ? DEFAULT_AUTO_LOCK_MS : deps.autoLockMs;

  let dek: Buffer | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let autoLockDueAt: number | null = null;

  function clearTimer(): void {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    autoLockDueAt = null;
  }

  function armTimer(): void {
    clearTimer();
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
      dek = freshDek;
      armTimer();
    },

    unlock(password) {
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
      wipe(kek);
      if (!verifierMatches(meta.verifier, candidate)) {
        wipe(candidate);
        throw new WrongMasterPasswordError();
      }
      lock();
      dek = candidate;
      armTimer();
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
      } finally {
        wipe(newKek);
      }
      // Adopt the (unchanged) DEK as the live session key.
      lock();
      dek = liveDek;
      armTimer();
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
  };
}
