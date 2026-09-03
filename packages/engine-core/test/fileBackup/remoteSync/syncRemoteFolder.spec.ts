import { mkdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withTempDir } from '../../helpers/tempDir.js';
import { syncRemoteFolder, type SyncRemoteFolderAdapter } from '../../../src/fileBackup/remoteSync/syncRemoteFolder.js';
import type { RemoteFile, RemoteTreeEntry } from '../../../src/transports/types.js';

/**
 * A plain fake satisfying SyncRemoteFolderAdapter — no real SFTP/FTP server
 * needed, since the whole point of this test is the diff/sync *logic*, not
 * the transport underneath (same "fake the external boundary, keep the
 * filesystem real" seam already used for resolveExecutorOverride/
 * testConnectionOverride elsewhere in this codebase).
 */
function fakeAdapter(tree: RemoteTreeEntry[], contents: Map<string, string>): SyncRemoteFolderAdapter & { downloadCalls: string[] } {
  const downloadCalls: string[] = [];
  return {
    downloadCalls,
    async listRemoteTree(): Promise<RemoteTreeEntry[]> {
      return tree;
    },
    async downloadFile(remote: RemoteFile, localTempPath: string) {
      downloadCalls.push(remote.remotePath);
      const content = contents.get(remote.remotePath) ?? '';
      await writeFile(localTempPath, content);
      return { bytesTransferred: Buffer.byteLength(content), sha256: 'irrelevant-for-this-test' };
    },
  };
}

describe('syncRemoteFolder', () => {
  it('downloads every file on the first run (empty staging dir)', async () => {
    await withTempDir(async (root) => {
      const staging = join(root, 'staging');
      const now = new Date('2026-01-01T00:00:00.000Z');
      const tree: RemoteTreeEntry[] = [
        { relativePath: 'a.txt', size: 3, modifiedAt: now },
        { relativePath: 'sub/b.txt', size: 3, modifiedAt: now },
      ];
      const contents = new Map([
        ['/remote/a.txt', 'aaa'],
        ['/remote/sub/b.txt', 'bbb'],
      ]);
      const adapter = fakeAdapter(tree, contents);

      const result = await syncRemoteFolder(adapter, '/remote', staging);

      expect(result).toEqual({ filesAdded: 2, filesChanged: 0, filesDeleted: 0, bytesTransferred: 6 });
      expect(await readFile(join(staging, 'a.txt'), 'utf8')).toBe('aaa');
      expect(await readFile(join(staging, 'sub', 'b.txt'), 'utf8')).toBe('bbb');
    });
  });

  it('skips a file whose size and mtime already match the staging copy — zero download calls', async () => {
    await withTempDir(async (root) => {
      const staging = join(root, 'staging');
      const mtime = new Date('2026-01-01T00:00:00.000Z');
      await mkdir(staging, { recursive: true });
      await writeFile(join(staging, 'a.txt'), 'aaa');
      await utimes(join(staging, 'a.txt'), mtime, mtime);

      const adapter = fakeAdapter([{ relativePath: 'a.txt', size: 3, modifiedAt: mtime }], new Map());

      const result = await syncRemoteFolder(adapter, '/remote', staging);

      expect(result).toEqual({ filesAdded: 0, filesChanged: 0, filesDeleted: 0, bytesTransferred: 0 });
      expect(adapter.downloadCalls).toEqual([]);
    });
  });

  it('re-downloads a file whose size changed, counting it as changed not added', async () => {
    await withTempDir(async (root) => {
      const staging = join(root, 'staging');
      const mtime = new Date('2026-01-01T00:00:00.000Z');
      await mkdir(staging, { recursive: true });
      await writeFile(join(staging, 'a.txt'), 'aaa');
      await utimes(join(staging, 'a.txt'), mtime, mtime);

      const newMtime = new Date('2026-01-02T00:00:00.000Z');
      const adapter = fakeAdapter(
        [{ relativePath: 'a.txt', size: 5, modifiedAt: newMtime }],
        new Map([['/remote/a.txt', 'aaaaa']])
      );

      const result = await syncRemoteFolder(adapter, '/remote', staging);

      expect(result).toEqual({ filesAdded: 0, filesChanged: 1, filesDeleted: 0, bytesTransferred: 5 });
      expect(await readFile(join(staging, 'a.txt'), 'utf8')).toBe('aaaaa');
    });
  });

  it('re-downloads a file whose mtime changed even if size is identical', async () => {
    await withTempDir(async (root) => {
      const staging = join(root, 'staging');
      const mtime = new Date('2026-01-01T00:00:00.000Z');
      await mkdir(staging, { recursive: true });
      await writeFile(join(staging, 'a.txt'), 'aaa');
      await utimes(join(staging, 'a.txt'), mtime, mtime);

      const newMtime = new Date('2026-01-02T00:00:00.000Z');
      const adapter = fakeAdapter([{ relativePath: 'a.txt', size: 3, modifiedAt: newMtime }], new Map([['/remote/a.txt', 'zzz']]));

      const result = await syncRemoteFolder(adapter, '/remote', staging);

      expect(result.filesChanged).toBe(1);
      expect(adapter.downloadCalls).toEqual(['/remote/a.txt']);
    });
  });

  it('deletes a staged file that no longer exists remotely', async () => {
    await withTempDir(async (root) => {
      const staging = join(root, 'staging');
      await mkdir(staging, { recursive: true });
      await writeFile(join(staging, 'gone.txt'), 'bye');

      const adapter = fakeAdapter([], new Map());

      const result = await syncRemoteFolder(adapter, '/remote', staging);

      expect(result).toEqual({ filesAdded: 0, filesChanged: 0, filesDeleted: 1, bytesTransferred: 0 });
      await expect(stat(join(staging, 'gone.txt'))).rejects.toThrow();
    });
  });

  it('sets the local file mtime to the remote-reported mtime after download, truncated to whole seconds', async () => {
    await withTempDir(async (root) => {
      const staging = join(root, 'staging');
      const remoteMtime = new Date('2026-03-15T12:34:56.789Z');
      const adapter = fakeAdapter([{ relativePath: 'a.txt', size: 1, modifiedAt: remoteMtime }], new Map([['/remote/a.txt', 'x']]));

      await syncRemoteFolder(adapter, '/remote', staging);

      const s = await stat(join(staging, 'a.txt'));
      expect(Math.floor(s.mtimeMs / 1000)).toBe(Math.floor(remoteMtime.getTime() / 1000));
    });
  });

  it('cleans up an orphaned .part file left over from an interrupted previous run', async () => {
    await withTempDir(async (root) => {
      const staging = join(root, 'staging');
      await mkdir(staging, { recursive: true });
      await writeFile(join(staging, 'stuck.txt.part'), 'half-downloaded');

      const adapter = fakeAdapter([], new Map());
      await syncRemoteFolder(adapter, '/remote', staging);

      await expect(stat(join(staging, 'stuck.txt.part'))).rejects.toThrow();
    });
  });

  it('handles a first-ever run against a staging directory that does not exist yet', async () => {
    await withTempDir(async (root) => {
      const staging = join(root, 'does-not-exist-yet');
      const adapter = fakeAdapter([{ relativePath: 'a.txt', size: 1, modifiedAt: new Date() }], new Map([['/remote/a.txt', 'x']]));

      const result = await syncRemoteFolder(adapter, '/remote', staging);

      expect(result.filesAdded).toBe(1);
    });
  });

  it('reports progress with the right file/byte totals, ending at 100%', async () => {
    await withTempDir(async (root) => {
      const staging = join(root, 'staging');
      const now = new Date('2026-01-01T00:00:00.000Z');
      const tree: RemoteTreeEntry[] = [
        { relativePath: 'a.txt', size: 3, modifiedAt: now },
        { relativePath: 'b.txt', size: 5, modifiedAt: now },
      ];
      const contents = new Map([
        ['/remote/a.txt', 'aaa'],
        ['/remote/b.txt', 'bbbbb'],
      ]);
      const updates: { filesDone: number; filesTotal: number; bytesDone: number; bytesTotal: number }[] = [];

      await syncRemoteFolder(fakeAdapter(tree, contents), '/remote', staging, { onProgress: (p) => updates.push(p) });

      expect(updates.length).toBeGreaterThan(0);
      expect(updates.every((u) => u.filesTotal === 2 && u.bytesTotal === 8)).toBe(true);
      const last = updates[updates.length - 1];
      expect(last).toMatchObject({ filesDone: 2, bytesDone: 8 });
    });
  });
});
