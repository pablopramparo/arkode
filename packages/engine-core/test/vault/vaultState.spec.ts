import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { migrationsSourceDir } from '../../src/paths.js';
import { DEFAULT_SCRYPT_PARAMS } from '../../src/vault/crypto.js';
import { createVaultMetaRepo } from '../../src/vault/vaultMetaRepo.js';
import {
  createVaultState,
  VaultAlreadyInitializedError,
  VaultLockedError,
  VaultNotInitializedError,
  WrongMasterPasswordError,
  type VaultState,
} from '../../src/vault/vaultState.js';

const FAST = { ...DEFAULT_SCRYPT_PARAMS, N: 2 ** 12 };

function freshState(opts: { autoLockMs?: number | null; now?: () => number; onAutoLock?: () => void } = {}) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrationsSourceDir());
  const vaultMetaRepo = createVaultMetaRepo(db);
  const state = createVaultState({ vaultMetaRepo, autoLockMs: opts.autoLockMs ?? null, now: opts.now, onAutoLock: opts.onAutoLock });
  return { db, vaultMetaRepo, state };
}

describe('VaultState lifecycle', () => {
  let state: VaultState;

  beforeEach(() => {
    ({ state } = freshState());
  });

  it('starts uninitialized and locked', () => {
    expect(state.isInitialized()).toBe(false);
    expect(state.isUnlocked()).toBe(false);
  });

  it('init sets the password, persists vault_meta, and leaves the vault unlocked', () => {
    state.init('correct horse battery staple', FAST);
    expect(state.isInitialized()).toBe(true);
    expect(state.isUnlocked()).toBe(true);
  });

  it('init a second time throws VaultAlreadyInitializedError', () => {
    state.init('pw-one', FAST);
    expect(() => state.init('pw-two', FAST)).toThrow(VaultAlreadyInitializedError);
  });

  it('unlock with the right password works; wrong password throws and stays locked', () => {
    state.init('right-password', FAST);
    state.lock();
    expect(state.isUnlocked()).toBe(false);

    expect(() => state.unlock('wrong-password')).toThrow(WrongMasterPasswordError);
    expect(state.isUnlocked()).toBe(false);

    state.unlock('right-password');
    expect(state.isUnlocked()).toBe(true);
  });

  it('unlock before init throws VaultNotInitializedError', () => {
    expect(() => state.unlock('anything')).toThrow(VaultNotInitializedError);
  });

  it('lock clears the in-memory key', () => {
    state.init('pw', FAST);
    state.lock();
    expect(() => state.withDek(() => 'x')).toThrow(VaultLockedError);
  });

  it('withDek runs only while unlocked', () => {
    state.init('pw', FAST);
    expect(state.withDek((dek) => dek.length)).toBe(32);
    state.lock();
    expect(() => state.withDek(() => 1)).toThrow(VaultLockedError);
  });
});

describe('VaultState.changePassword', () => {
  it('re-wraps with a fresh salt; the new password unlocks, the old one no longer does', () => {
    const { state, vaultMetaRepo } = freshState();
    state.init('old-password', FAST);
    const saltBefore = Buffer.from(vaultMetaRepo.get()!.kekSalt);

    state.changePassword('old-password', 'new-password', FAST);
    const saltAfter = vaultMetaRepo.get()!.kekSalt;
    expect(saltAfter.equals(saltBefore)).toBe(false);
    expect(state.isUnlocked()).toBe(true);

    state.lock();
    expect(() => state.unlock('old-password')).toThrow(WrongMasterPasswordError);
    state.unlock('new-password');
    expect(state.isUnlocked()).toBe(true);
  });

  it('rejects a wrong current password without changing anything', () => {
    const { state, vaultMetaRepo } = freshState();
    state.init('the-real-one', FAST);
    const before = Buffer.from(vaultMetaRepo.get()!.wrappedDek);
    expect(() => state.changePassword('not-it', 'whatever', FAST)).toThrow(WrongMasterPasswordError);
    expect(vaultMetaRepo.get()!.wrappedDek.equals(before)).toBe(true);
  });

  it('keeps the SAME data key so existing secrets still decrypt (verifier survives)', () => {
    const { state, vaultMetaRepo } = freshState();
    state.init('p1', FAST);
    const dekBefore = state.withDek((d) => Buffer.from(d).toString('hex'));
    state.changePassword('p1', 'p2', FAST);
    const dekAfter = state.withDek((d) => Buffer.from(d).toString('hex'));
    expect(dekAfter).toBe(dekBefore);
    // meta.verifier still validates (change-password rebuilt it under the same DEK)
    expect(vaultMetaRepo.get()!.verifier.length).toBeGreaterThan(0);
  });
});

describe('VaultState auto-lock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('locks itself after the idle window and fires onAutoLock', () => {
    const onAutoLock = vi.fn();
    const { state } = freshState({ autoLockMs: 1000, onAutoLock });
    state.init('pw', FAST);
    expect(state.isUnlocked()).toBe(true);

    vi.advanceTimersByTime(999);
    expect(state.isUnlocked()).toBe(true);

    vi.advanceTimersByTime(2);
    expect(state.isUnlocked()).toBe(false);
    expect(onAutoLock).toHaveBeenCalledTimes(1);
  });

  it('touch() and withDek() reset the idle timer', () => {
    const { state } = freshState({ autoLockMs: 1000 });
    state.init('pw', FAST);

    vi.advanceTimersByTime(800);
    state.touch();
    vi.advanceTimersByTime(800);
    expect(state.isUnlocked()).toBe(true); // would have locked at 1000 without the touch

    state.withDek(() => 0);
    vi.advanceTimersByTime(800);
    expect(state.isUnlocked()).toBe(true);

    vi.advanceTimersByTime(300);
    expect(state.isUnlocked()).toBe(false);
  });

  it('autoLockMs null disables the timer', () => {
    const { state } = freshState({ autoLockMs: null });
    state.init('pw', FAST);
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(state.isUnlocked()).toBe(true);
    expect(state.autoLockAt()).toBeNull();
  });
});
