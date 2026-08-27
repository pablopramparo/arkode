import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hardenAllKeyFilesIn, hardenKeyFileAcl } from '../../src/transports/keyFilePermissions.js';
import { withTempDir } from '../helpers/tempDir.js';

const execFileAsync = promisify(execFile);
const isWindows = process.platform === 'win32';
const OPENSSH_KEYGEN = 'C:\\Windows\\System32\\OpenSSH\\ssh-keygen.exe';

/**
 * Generates a real ed25519 keypair via the real Windows OpenSSH ssh-keygen —
 * the same binary whose own "Permissions ... are too open" rejection is the
 * bug this module fixes, so verifying against it (rather than just reading
 * `icacls` output) proves the fix in the terms that actually matter.
 */
async function generateRealKeypair(destPath: string): Promise<void> {
  await execFileAsync(OPENSSH_KEYGEN, ['-t', 'ed25519', '-N', '', '-f', destPath, '-q']);
}

/** BUILTIN\Users, referenced by well-known SID for the same locale reason keyFilePermissions.ts uses SIDs elsewhere. */
const SID_BUILTIN_USERS = '*S-1-5-32-545';

/**
 * A plain per-user %TEMP% directory (what withTempDir gives by default) is
 * NOT actually broad enough to reproduce the reported bug on a stock
 * Windows install — it inherits from the user's own profile, which
 * typically doesn't grant BUILTIN\Users anything. The real, confirmed
 * root cause is specific to %PROGRAMDATA%\arkode\keys\, a *machine-wide*
 * location whose own default ACL does grant BUILTIN\Users Read (confirmed
 * by hand against this app's real key store: `icacls` showed
 * `BUILTIN\Usuarios:(I)(RX)` on an un-hardened key there). Simulating that
 * broad grant explicitly here, rather than relying on ambient/environment-
 * specific temp-dir ACL quirks, makes the repro deterministic.
 */
async function grantBroadReadAccess(dir: string): Promise<void> {
  await execFileAsync('icacls.exe', [dir, '/grant', `${SID_BUILTIN_USERS}:(OI)(CI)R`]);
}

describe.skipIf(!isWindows)('hardenKeyFileAcl (Windows only)', () => {
  it('produces a key file the real Windows OpenSSH client accepts, where the un-hardened default is rejected', async () => {
    await withTempDir(async (generatedDir) => {
      await withTempDir(async (storeDir) => {
        await grantBroadReadAccess(storeDir);
        const generatedPath = join(generatedDir, 'id_ed25519');
        await generateRealKeypair(generatedPath);
        // Copied in, not generated in place — ssh-keygen itself already
        // writes a newly-generated key with secure permissions regardless
        // of the parent folder's ACL, which would never reproduce the real
        // bug. copyPrivateKeyIntoAppStorage's own real code path is a copy
        // too (copyFileSync), which — like this — inherits the destination
        // folder's ACL normally.
        const keyPath = join(storeDir, 'id_ed25519');
        copyFileSync(generatedPath, keyPath);

        // With the broad grant above in place (matching %PROGRAMDATA%\arkode\keys\'s
        // own real default), ssh-keygen -y already refuses this key before
        // hardening — the exact bug reported ("Permissions ... are too open").
        // Confirms the test's own baseline is a real repro, not a no-op.
        await expect(execFileAsync(OPENSSH_KEYGEN, ['-y', '-f', keyPath])).rejects.toThrow();

        await hardenKeyFileAcl(keyPath);

        const { stdout } = await execFileAsync(OPENSSH_KEYGEN, ['-y', '-f', keyPath]);
        expect(stdout.trim()).toMatch(/^ssh-ed25519 /);
      });
    });
  }, 20_000);

  it('grants exactly current-user/SYSTEM/Administrators, with inheritance broken', async () => {
    await withTempDir(async (generatedDir) => {
      await withTempDir(async (storeDir) => {
        await grantBroadReadAccess(storeDir);
        const generatedPath = join(generatedDir, 'id_ed25519');
        await generateRealKeypair(generatedPath);
        const keyPath = join(storeDir, 'id_ed25519');
        copyFileSync(generatedPath, keyPath);

        await hardenKeyFileAcl(keyPath);

        const { stdout } = await execFileAsync('icacls.exe', [keyPath]);
        // No (I) inherited-permission markers should remain — /inheritance:r
        // stripped them, so every remaining ACE is one we granted explicitly.
        expect(stdout).not.toMatch(/\(I\)/);
        // The broad principal that caused the original bug (BUILTIN\Users,
        // matched only as an ACE principal — i.e. immediately followed by a
        // colon — not as a substring of the file's own path, which on this
        // dev machine happens to contain "\Users\" too) must not remain.
        expect(stdout.toLowerCase()).not.toMatch(/\\us(ers|uarios):/);
        // SYSTEM's display name isn't localized, unlike Administrators/
        // Administradores — icacls prints the resolved display name, not
        // the SID we granted with, so match on the shared, locale-stable
        // "administr" prefix instead of the full English word.
        expect(stdout).toMatch(/SYSTEM:\(F\)/);
        expect(stdout).toMatch(/administr\S*:\(F\)/i);
      });
    });
  });

  it('hardenAllKeyFilesIn sweeps every .key file in a directory and skips non-.key files', async () => {
    await withTempDir(async (dir) => {
      const keyPathA = join(dir, 'a.key');
      const keyPathB = join(dir, 'b.key');
      await generateRealKeypair(join(dir, 'a'));
      copyFileSync(join(dir, 'a'), keyPathA);
      await generateRealKeypair(join(dir, 'b'));
      copyFileSync(join(dir, 'b'), keyPathB);
      writeFileSync(join(dir, 'notes.txt'), 'not a key');

      const result = await hardenAllKeyFilesIn(dir);

      expect(result.errors).toEqual([]);
      expect(result.hardened.sort()).toEqual([keyPathA, keyPathB].sort());

      // Both are now genuinely accepted by real OpenSSH, not just "no error thrown".
      await execFileAsync(OPENSSH_KEYGEN, ['-y', '-f', keyPathA]);
      await execFileAsync(OPENSSH_KEYGEN, ['-y', '-f', keyPathB]);
    });
  }, 20_000);

  it('is idempotent — running it twice on an already-hardened key is a harmless no-op', async () => {
    await withTempDir(async (dir) => {
      const keyPath = join(dir, 'id_ed25519');
      await generateRealKeypair(keyPath);

      await hardenKeyFileAcl(keyPath);
      await expect(hardenKeyFileAcl(keyPath)).resolves.not.toThrow();

      const { stdout } = await execFileAsync(OPENSSH_KEYGEN, ['-y', '-f', keyPath]);
      expect(stdout.trim()).toMatch(/^ssh-ed25519 /);
    });
  }, 20_000);

  it('hardenAllKeyFilesIn on a directory that does not exist yet is a harmless no-op', async () => {
    const result = await hardenAllKeyFilesIn('C:\\this\\path\\does\\not\\exist\\arkode-test');
    expect(result).toEqual({ hardened: [], errors: [] });
  });
});

describe.skipIf(isWindows)('hardenKeyFileAcl (non-Windows)', () => {
  it('is a no-op off Windows, so it is always safe to call unconditionally', async () => {
    await withTempDir(async (dir) => {
      const keyPath = join(dir, 'id_ed25519');
      writeFileSync(keyPath, 'not a real key, just checking this does not throw');
      await expect(hardenKeyFileAcl(keyPath)).resolves.toBeUndefined();
    });
  });
});
