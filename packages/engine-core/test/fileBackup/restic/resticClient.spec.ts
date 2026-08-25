import { writeFile, mkdir, unlink, readFile, mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withTempDir } from '../../helpers/tempDir.js';
import { buildForgetArgs, initRepository, runBackup, diffSnapshots, forget, prune, check, restoreSnapshot, dumpFile } from '../../../src/fileBackup/restic/resticClient.js';

/**
 * A restic restore recreates the FULL absolute source path under the target
 * (verified in the PoC: `target\C\Users\...`), and the recreated top-level
 * ancestor directory can end up with a Windows permission/security-
 * descriptor state that a plain recursive Node fs.rm() can't remove
 * (confirmed here too — a real EPERM, not a flake). Isolating the restore
 * target as its OWN standalone temp dir, cleaned up independently via a
 * native `rmdir /s /q` with errors swallowed, keeps that OS-level quirk
 * from failing this test's cleanup — it's the same finding already on file
 * from manual PoC testing, not new behavior introduced by this domain.
 */
async function withIsolatedRestoreDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'codebius-restic-restore-'));
  try {
    return await fn(dir);
  } finally {
    await new Promise<void>((resolve) => {
      execFile('cmd', ['/c', 'rmdir', '/s', '/q', dir], () => resolve());
    });
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

describe('buildForgetArgs (pure, no restic binary needed)', () => {
  it('always includes a --keep-last 1 floor even with no policy at all', () => {
    const args = buildForgetArgs('D:\\repo', { path: 'D:\\src' });
    expect(args).toEqual(['-r', 'D:\\repo', 'forget', '--path', 'D:\\src', '--json', '--keep-last', '1']);
  });

  it('unions --keep-last with the configured count, never dropping below the floor of 1', () => {
    expect(buildForgetArgs('D:\\repo', { path: 'D:\\src', keepLast: 5 })).toContain('5');
    expect(buildForgetArgs('D:\\repo', { path: 'D:\\src', keepLast: 0 })).toContain('1'); // a misconfigured 0 still floors to 1
  });

  it('adds --keep-within only when days is configured, alongside the keep-last floor', () => {
    const args = buildForgetArgs('D:\\repo', { path: 'D:\\src', keepWithinDays: 30 });
    expect(args).toContain('--keep-within');
    expect(args).toContain('30d');
    expect(args).toContain('--keep-last');
    expect(args).toContain('1');
  });

  it('always scopes with --path', () => {
    expect(buildForgetArgs('D:\\repo', { path: 'D:\\some\\source' })).toContain('--path');
    expect(buildForgetArgs('D:\\repo', { path: 'D:\\some\\source' })).toContain('D:\\some\\source');
  });
});

// The rest of this suite shells out to a REAL restic.exe against real temp
// directories — same "no mocking the filesystem/external tool" standard
// already used for the transport adapters. Self-skips when RESTIC_PATH
// isn't configured (e.g. a clean checkout/CI runner with no restic vendored
// yet — packaging that in is separate, later work), mirroring how
// machineDpapiStore.spec.ts self-skips on non-Windows.
const hasRestic = Boolean(process.env.RESTIC_PATH);

describe.skipIf(!hasRestic)('resticClient (real restic.exe)', () => {
  it('init -> backup -> diff -> forget -> prune -> check -> restore -> dump, end to end', async () => {
    await withTempDir(async (root) => {
      const repoPath = join(root, 'repo');
      const sourcePath = join(root, 'source');
      await mkdir(sourcePath, { recursive: true });
      await writeFile(join(sourcePath, 'a.txt'), 'hello world');
      await writeFile(join(sourcePath, 'b.txt'), 'unchanged forever');
      const password = 'test-password-not-a-real-secret';

      const { resticRepoId } = await initRepository(repoPath, password);
      expect(resticRepoId).toBeTruthy();

      // Calling init again must be a safe no-op (idempotent).
      const second = await initRepository(repoPath, password);
      expect(second.resticRepoId).toBe(resticRepoId);

      const summary1 = await runBackup(repoPath, password, sourcePath, { tag: 'task-1' });
      expect(summary1.snapshotId).toBeTruthy();
      expect(summary1.filesNew).toBe(2);
      expect(summary1.totalFilesProcessed).toBe(2);

      // Modify one file, delete nothing yet.
      await writeFile(join(sourcePath, 'a.txt'), 'hello world, modified');
      const summary2 = await runBackup(repoPath, password, sourcePath, { tag: 'task-1' });
      expect(summary2.filesChanged).toBe(1);
      expect(summary2.filesUnmodified).toBe(1);

      const diff = await diffSnapshots(repoPath, password, summary1.snapshotId, summary2.snapshotId);
      expect(diff.filesRemoved).toBe(0);

      // Now delete b.txt and confirm the diff reports it removed.
      await unlink(join(sourcePath, 'b.txt'));
      const summary3 = await runBackup(repoPath, password, sourcePath, { tag: 'task-1' });
      const diff2 = await diffSnapshots(repoPath, password, summary2.snapshotId, summary3.snapshotId);
      expect(diff2.filesRemoved).toBe(1);

      // forget with keep-last 1 should remove the two older snapshots.
      const { removedSnapshotIds } = await forget(repoPath, password, { path: sourcePath, keepLast: 1 });
      expect(removedSnapshotIds.sort()).toEqual([summary1.snapshotId, summary2.snapshotId].sort());

      const pruneResult = await prune(repoPath, password, { maxUnused: '0' });
      expect(pruneResult.bytesReclaimed).toBeGreaterThanOrEqual(0);

      const checkResult = await check(repoPath, password, { readData: false });
      expect(checkResult.ok).toBe(true);

      await withIsolatedRestoreDir(async (restoreDir) => {
        const restoreResult = await restoreSnapshot(repoPath, password, summary3.snapshotId, restoreDir);
        expect(restoreResult.filesRestored).toBeGreaterThan(0);
      });

      const dumpDest = join(root, 'dumped-a.txt');
      await dumpFile(repoPath, password, summary3.snapshotId, join(sourcePath, 'a.txt'), dumpDest);
      const dumped = await readFile(dumpDest, 'utf8');
      expect(dumped).toBe('hello world, modified');
    });
  }, 60_000);

  it('surfaces a clean error for a wrong password', async () => {
    await withTempDir(async (root) => {
      const repoPath = join(root, 'repo');
      await initRepository(repoPath, 'correct-password');
      await expect(initRepository(repoPath, 'wrong-password')).rejects.toThrow();
    });
  }, 30_000);
});
