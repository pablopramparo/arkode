import { mkdir, readdir, rename, stat, unlink, utimes } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { RemoteFile, RemoteTreeEntry, DownloadResult } from '../../transports/types.js';

/**
 * The minimal shape syncRemoteFolder actually needs — both SftpAdapter and
 * FtpAdapter satisfy this structurally, so tests can pass a plain fake
 * object instead of a real connected adapter (same "fake the external
 * boundary, keep the filesystem real" seam already used elsewhere in this
 * codebase, e.g. RunBackupTaskDeps.resolveExecutorOverride).
 */
export interface SyncRemoteFolderAdapter {
  listRemoteTree(remoteDir: string): Promise<RemoteTreeEntry[]>;
  downloadFile(
    remote: RemoteFile,
    localTempPath: string,
    opts?: { onProgress?: (transferred: number, total: number) => void }
  ): Promise<DownloadResult>;
}

export interface SyncRemoteFolderResult {
  filesAdded: number;
  filesChanged: number;
  filesDeleted: number;
  bytesTransferred: number;
}

export interface SyncProgress {
  /** Files transferred so far / total files this sync needs to transfer (new + changed). */
  filesDone: number;
  filesTotal: number;
  /** Bytes transferred so far / total bytes to transfer — the sum of the to-transfer files' remote sizes. */
  bytesDone: number;
  bytesTotal: number;
}

export interface SyncRemoteFolderOptions {
  onProgress?: (progress: SyncProgress) => void;
}

interface LocalEntry {
  size: number;
  mtimeSeconds: number;
}

/**
 * The staging mirror itself doubles as the "previous remote state" manifest
 * — no separate SQLite table needed. mtimes are truncated to whole seconds
 * (SFTP/FTP timestamps are typically second-precision; comparing untruncated
 * sub-second local fs.stat() values against them would cause spurious
 * re-downloads every single run).
 */
async function walkLocalDir(rootDir: string, currentDir: string = rootDir, relativePrefix = ''): Promise<Map<string, LocalEntry>> {
  const result = new Map<string, LocalEntry>();
  let entries;
  try {
    entries = await readdir(currentDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return result; // first run ever — nothing staged yet
    throw err;
  }
  for (const entry of entries) {
    const relativePath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
    const fullPath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      const sub = await walkLocalDir(rootDir, fullPath, relativePath);
      for (const [k, v] of sub) result.set(k, v);
    } else if (entry.isFile() && !entry.name.endsWith('.part')) {
      const s = await stat(fullPath);
      result.set(relativePath, { size: s.size, mtimeSeconds: Math.floor(s.mtimeMs / 1000) });
    }
  }
  return result;
}

/** A `.part` file found here means a previous sync was interrupted mid-download — normal operation always renames immediately after each transfer completes, so any survivor is orphaned by definition (no age check needed, unlike the DB orchestrator's cleanupOrphanedPartFiles, which has to tolerate a run genuinely still in progress). */
async function cleanupOrphanedPartFiles(dir: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await cleanupOrphanedPartFiles(fullPath);
    } else if (entry.isFile() && entry.name.endsWith('.part')) {
      await unlink(fullPath).catch(() => {});
    }
  }
}

/**
 * The whole "Capa 1" this app has to build regardless of storage engine —
 * restic's own SFTP support is repository-storage-only, never source-side.
 * Recursively lists the remote tree, diffs it against the local staging
 * mirror (by path + size + mtime, no remote hashing), downloads only
 * new/changed files, and deletes from staging whatever disappeared
 * remotely. That last part is the entire mechanism by which "a file
 * deleted remotely stays recoverable" holds: restic's own snapshot
 * immutability (already proven for local_folder) means the *previous*
 * snapshot still has it — nothing new needs to be built for that guarantee.
 *
 * A full recursive listing runs every time; only the local staging side is
 * cached (as the staging mirror's own contents, not a separate table).
 * Renames/moves at the remote source are not detected as such — same
 * "no heuristic newest-file guessing" principle already established for
 * remote_dump — so a rename costs a full re-download over the wire (though
 * restic's own content-addressing still dedupes it on disk once staged).
 */
export async function syncRemoteFolder(
  adapter: SyncRemoteFolderAdapter,
  remoteRootDir: string,
  localStagingDir: string,
  opts: SyncRemoteFolderOptions = {}
): Promise<SyncRemoteFolderResult> {
  await mkdir(localStagingDir, { recursive: true });
  await cleanupOrphanedPartFiles(localStagingDir);

  const remoteEntries = await adapter.listRemoteTree(remoteRootDir);
  const localEntries = await walkLocalDir(localStagingDir);
  const remotePaths = new Set(remoteEntries.map((e) => e.relativePath));
  const baseRemoteDir = remoteRootDir.replace(/\/$/, '');

  // Everything that needs transferring, resolved up front so progress has a
  // real denominator (files + bytes) before the first download starts.
  const toTransfer = remoteEntries.filter((remote) => {
    const local = localEntries.get(remote.relativePath);
    const remoteMtimeSeconds = Math.floor(remote.modifiedAt.getTime() / 1000);
    return !(local != null && local.size === remote.size && local.mtimeSeconds === remoteMtimeSeconds);
  });
  const bytesTotal = toTransfer.reduce((sum, e) => sum + e.size, 0);

  let filesAdded = 0;
  let filesChanged = 0;
  let bytesTransferred = 0;
  const report = () => opts.onProgress?.({ filesDone: filesAdded + filesChanged, filesTotal: toTransfer.length, bytesDone: bytesTransferred, bytesTotal });
  report();

  for (const remote of toTransfer) {
    const local = localEntries.get(remote.relativePath);
    const localPath = join(localStagingDir, ...remote.relativePath.split('/'));
    await mkdir(dirname(localPath), { recursive: true });
    const tempPath = `${localPath}.part`;
    const remoteFile: RemoteFile = {
      remotePath: `${baseRemoteDir}/${remote.relativePath}`,
      fileName: remote.relativePath.split('/').pop() ?? remote.relativePath,
      size: remote.size,
      modifiedAt: remote.modifiedAt,
    };

    const bytesBeforeThisFile = bytesTransferred;
    const result = await adapter.downloadFile(remoteFile, tempPath, {
      onProgress: (transferred) => {
        bytesTransferred = bytesBeforeThisFile + transferred;
        report();
      },
    });
    await rename(tempPath, localPath);
    // Set *after* the rename, on the final path — without this, the next
    // run's diff has nothing meaningful to compare against (every local
    // mtime would just read "whenever we last downloaded it").
    await utimes(localPath, remote.modifiedAt, remote.modifiedAt);

    // Authoritative end-of-file value (the onProgress callback above may not
    // fire a final time, or at all on a zero-byte file).
    bytesTransferred = bytesBeforeThisFile + result.bytesTransferred;
    if (local) filesChanged++;
    else filesAdded++;
    report();
  }

  let filesDeleted = 0;
  for (const relativePath of localEntries.keys()) {
    if (!remotePaths.has(relativePath)) {
      const localPath = join(localStagingDir, ...relativePath.split('/'));
      await unlink(localPath).catch(() => {});
      filesDeleted++;
    }
  }

  return { filesAdded, filesChanged, filesDeleted, bytesTransferred };
}
