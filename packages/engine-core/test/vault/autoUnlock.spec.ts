import Database from 'better-sqlite3';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { migrationsSourceDir } from '../../src/paths.js';
import { DEFAULT_SCRYPT_PARAMS } from '../../src/vault/crypto.js';
import { createVaultMetaRepo } from '../../src/vault/vaultMetaRepo.js';
import { createVaultAutoUnlock, currentUserDpapiProvider, type DpapiProvider } from '../../src/vault/autoUnlock.js';
import { createVaultState, VaultAutoUnlockUnavailableError } from '../../src/vault/vaultState.js';
import { withTempDir } from '../helpers/tempDir.js';

const FAST = { ...DEFAULT_SCRYPT_PARAMS, N: 2 ** 12 };
const PW = 'correct horse battery staple';

/** Simulates DPAPI: a blob is only "unsealable" by the same (fake) Windows context. */
function fakeDpapi(context = 'userA'): DpapiProvider {
  const TAG = Buffer.from(`dpapi:${context}:`, 'utf8');
  return {
    isSupported: true,
    protect: (data) => Buffer.concat([TAG, data]),
    unprotect: (blob) => {
      if (blob.length < TAG.length || !blob.subarray(0, TAG.length).equals(TAG)) {
        throw new Error('wrong DPAPI context');
      }
      return Buffer.from(blob.subarray(TAG.length));
    },
  };
}

/** A fresh DB + one auto-unlock file path, shared across the "processes" a test spins up. */
function fresh(dir: string) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrationsSourceDir());
  return { db, vaultMetaRepo: createVaultMetaRepo(db), filePath: join(dir, 'vault-auto-unlock.bin') };
}

function stateWith(
  ctx: ReturnType<typeof fresh>,
  opts: { dpapi?: DpapiProvider; withAutoUnlock?: boolean; autoLockMs?: number | null; now?: () => number; onAutoLock?: () => void } = {}
) {
  const autoUnlock =
    opts.withAutoUnlock === false
      ? undefined
      : createVaultAutoUnlock({ filePath: ctx.filePath, dpapi: opts.dpapi ?? fakeDpapi(), hardenFile: () => {} });
  return createVaultState({
    vaultMetaRepo: ctx.vaultMetaRepo,
    autoLockMs: opts.autoLockMs ?? null,
    now: opts.now,
    onAutoLock: opts.onAutoLock,
    autoUnlock,
  });
}

describe('vault auto-unlock', () => {
  it('1. a fresh process auto-unlocks from local material (no master password)', async () => {
    await withTempDir(async (dir) => {
      const ctx = fresh(dir);
      const s1 = stateWith(ctx);
      s1.init(PW, FAST);
      s1.enableAutoUnlock(PW);
      expect(existsSync(ctx.filePath)).toBe(true);

      // A new "process" over the same DB + material file.
      const s2 = stateWith(ctx);
      expect(s2.isUnlocked()).toBe(false);
      expect(s2.attemptStartupAutoUnlock()).toBe(true);
      expect(s2.isUnlocked()).toBe(true);
      expect(s2.withDek((d) => d.length)).toBe(32);
    });
  });

  it('1b. the unlock checkbox path (unlock + enableAutoUnlock) also arms it', async () => {
    await withTempDir(async (dir) => {
      const ctx = fresh(dir);
      stateWith(ctx).init(PW, FAST);
      const s1 = stateWith(ctx);
      s1.unlock(PW, { enableAutoUnlock: true });
      expect(s1.autoUnlockStatus().state).toBe('enabled');
      const s2 = stateWith(ctx);
      expect(s2.attemptStartupAutoUnlock()).toBe(true);
    });
  });

  it('2. with auto-unlock disabled, startup stays locked and the master password still works', async () => {
    await withTempDir(async (dir) => {
      const ctx = fresh(dir);
      stateWith(ctx).init(PW, FAST);

      const s = stateWith(ctx);
      expect(s.autoUnlockStatus().state).toBe('disabled');
      expect(s.attemptStartupAutoUnlock()).toBe(false);
      expect(s.isUnlocked()).toBe(false);
      s.unlock(PW);
      expect(s.isUnlocked()).toBe(true);
    });
  });

  it('3. material from another Windows context cannot unlock, and is deleted', async () => {
    await withTempDir(async (dir) => {
      const ctx = fresh(dir);
      const sA = stateWith(ctx, { dpapi: fakeDpapi('userA') });
      sA.init(PW, FAST);
      sA.enableAutoUnlock(PW);

      const sB = stateWith(ctx, { dpapi: fakeDpapi('userB') });
      expect(sB.attemptStartupAutoUnlock()).toBe(false);
      expect(sB.isUnlocked()).toBe(false);
      expect(() => sB.unlockWithWindows()).toThrow(VaultAutoUnlockUnavailableError);
      expect(existsSync(ctx.filePath)).toBe(false); // self-healed
    });
  });

  it('4. material from a previous master-password epoch is detected as stale and deleted', async () => {
    await withTempDir(async (dir) => {
      const ctx = fresh(dir);
      const s1 = stateWith(ctx);
      s1.init(PW, FAST);
      s1.enableAutoUnlock(PW);

      // Password changed "on another machine" — this state has no auto-unlock dep,
      // so the local file keeps the OLD kek_salt fingerprint.
      stateWith(ctx, { withAutoUnlock: false }).changePassword(PW, 'a-new-password', FAST);

      const s2 = stateWith(ctx);
      expect(s2.autoUnlockStatus().state).toBe('stale');
      expect(existsSync(ctx.filePath)).toBe(false);
      expect(s2.attemptStartupAutoUnlock()).toBe(false);
    });
  });

  it('5. a corrupt blob is rejected and deleted, falling back to manual unlock', async () => {
    await withTempDir(async (dir) => {
      const ctx = fresh(dir);
      const s1 = stateWith(ctx);
      s1.init(PW, FAST);
      s1.enableAutoUnlock(PW);

      const raw = readFileSync(ctx.filePath);
      raw[3] ^= 0xff; // trash the magic
      writeFileSync(ctx.filePath, raw);

      const s2 = stateWith(ctx);
      expect(s2.autoUnlockStatus().state).toBe('error');
      expect(existsSync(ctx.filePath)).toBe(false);
      s2.unlock(PW);
      expect(s2.isUnlocked()).toBe(true);
    });
  });

  it('6. disable removes the local material', async () => {
    await withTempDir(async (dir) => {
      const ctx = fresh(dir);
      const s = stateWith(ctx);
      s.init(PW, FAST);
      s.enableAutoUnlock(PW);
      expect(existsSync(ctx.filePath)).toBe(true);

      s.disableAutoUnlock();
      expect(existsSync(ctx.filePath)).toBe(false);
      expect(s.autoUnlockStatus().state).toBe('disabled');
    });
  });

  it('7. changing the master password re-seals the local material for the new epoch', async () => {
    await withTempDir(async (dir) => {
      const ctx = fresh(dir);
      const s1 = stateWith(ctx);
      s1.init(PW, FAST);
      s1.enableAutoUnlock(PW);
      const before = readFileSync(ctx.filePath);

      s1.changePassword(PW, 'brand-new-password', FAST);
      const after = readFileSync(ctx.filePath);
      expect(after.equals(before)).toBe(false); // re-sealed
      expect(s1.autoUnlockStatus().state).toBe('enabled');

      // A fresh process auto-unlocks with the NEW epoch's material, no password.
      const s2 = stateWith(ctx);
      expect(s2.attemptStartupAutoUnlock()).toBe(true);
      expect(s2.isUnlocked()).toBe(true);
    });
  });

  it('8. a fresh install / restore never inherits auto-unlock', async () => {
    await withTempDir(async (dir) => {
      // "restore into a fresh install": a brand-new vault; restore writes NO material file.
      const ctx = fresh(dir);
      stateWith(ctx).init('restored-master-password', FAST);

      const s = stateWith(ctx); // a fresh "process" on the restored machine
      expect(s.autoUnlockStatus().state).toBe('disabled');
      expect(s.attemptStartupAutoUnlock()).toBe(false);
      expect(s.isUnlocked()).toBe(false);

      // Even if a foreign machine's material file was ALSO copied over:
      writeFileSync(ctx.filePath, Buffer.from(`ARKAU\x01${'x'.repeat(40)}`, 'binary'));
      const s2 = stateWith(ctx, { dpapi: fakeDpapi('some-other-user') });
      expect(s2.attemptStartupAutoUnlock()).toBe(false);
      expect(s2.isUnlocked()).toBe(false);
    });
  });

  describe('lock behaviour', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('9. auto-unlock ON => idle auto-lock is suppressed', async () => {
      await withTempDir(async (dir) => {
        const ctx = fresh(dir);
        const onAutoLock = vi.fn();
        const s = stateWith(ctx, { autoLockMs: 1000, onAutoLock });
        s.init(PW, FAST);
        s.enableAutoUnlock(PW);

        vi.advanceTimersByTime(60 * 60 * 1000);
        expect(s.isUnlocked()).toBe(true);
        expect(onAutoLock).not.toHaveBeenCalled();
        expect(s.autoLockAt()).toBeNull();
      });
    });

    it('10. auto-unlock OFF => the existing idle auto-lock still fires', async () => {
      await withTempDir(async (dir) => {
        const ctx = fresh(dir);
        const onAutoLock = vi.fn();
        const s = stateWith(ctx, { autoLockMs: 1000, onAutoLock });
        s.init(PW, FAST); // never enabled

        vi.advanceTimersByTime(1001);
        expect(s.isUnlocked()).toBe(false);
        expect(onAutoLock).toHaveBeenCalledTimes(1);
      });
    });
  });

  it('11. after a manual lock the vault stays locked (no automatic re-unlock this process)', async () => {
    await withTempDir(async (dir) => {
      const ctx = fresh(dir);
      const s = stateWith(ctx);
      s.init(PW, FAST);
      s.enableAutoUnlock(PW);

      s.lock();
      expect(s.isUnlocked()).toBe(false);
      expect(s.attemptStartupAutoUnlock()).toBe(false); // manual lock blocks the automatic path
      expect(s.isUnlocked()).toBe(false);
    });
  });

  it('12. "unlock with Windows" works explicitly after a manual lock (no master password)', async () => {
    await withTempDir(async (dir) => {
      const ctx = fresh(dir);
      const s = stateWith(ctx);
      s.init(PW, FAST);
      s.enableAutoUnlock(PW);

      s.lock();
      expect(s.isUnlocked()).toBe(false);
      s.unlockWithWindows();
      expect(s.isUnlocked()).toBe(true);
      expect(s.withDek((d) => d.length)).toBe(32);
    });
  });

  it('13. a state with no auto-unlock dep (the LocalSystem scheduler) has no path to the KEK/DEK', async () => {
    await withTempDir(async (dir) => {
      const ctx = fresh(dir);
      // A "user" process enables it...
      const user = stateWith(ctx, { dpapi: fakeDpapi('interactive-user') });
      user.init(PW, FAST);
      user.enableAutoUnlock(PW);

      // ...the scheduler builds a vaultState WITHOUT the autoUnlock dependency.
      const scheduler = stateWith(ctx, { withAutoUnlock: false });
      expect(scheduler.autoUnlockStatus().state).toBe('unsupported');
      expect(scheduler.attemptStartupAutoUnlock()).toBe(false);
      expect(() => scheduler.unlockWithWindows()).toThrow(VaultAutoUnlockUnavailableError);
      expect(scheduler.isUnlocked()).toBe(false);

      // And even a CurrentUser-scoped blob is inert to another context (LocalSystem):
      const asSystem = stateWith(ctx, { dpapi: fakeDpapi('LocalSystem') });
      expect(asSystem.attemptStartupAutoUnlock()).toBe(false);
      expect(asSystem.isUnlocked()).toBe(false);
    });
  });
});

// Real Windows DPAPI round-trip — mirrors machineDpapiStore.spec.ts's gating.
describe.skipIf(process.platform !== 'win32')('vault auto-unlock — real DPAPI (CurrentUser)', () => {
  it('seals and recovers the KEK through the real OS primitive', async () => {
    await withTempDir(async (dir) => {
      const ctx = fresh(dir);
      const s1 = createVaultState({
        vaultMetaRepo: ctx.vaultMetaRepo,
        autoLockMs: null,
        autoUnlock: createVaultAutoUnlock({ filePath: ctx.filePath, dpapi: currentUserDpapiProvider, hardenFile: () => {} }),
      });
      s1.init(PW, FAST);
      s1.enableAutoUnlock(PW);

      const s2 = createVaultState({
        vaultMetaRepo: ctx.vaultMetaRepo,
        autoLockMs: null,
        autoUnlock: createVaultAutoUnlock({ filePath: ctx.filePath, dpapi: currentUserDpapiProvider, hardenFile: () => {} }),
      });
      expect(s2.attemptStartupAutoUnlock()).toBe(true);
      expect(s2.withDek((d) => d.length)).toBe(32);
    });
  });
});
