import { join } from 'node:path';
import type { Transport } from '../types.js';
import type { RemoteFile } from '../transports/types.js';
import type { SecretStore } from '../secrets/types.js';
import type { KnownHostsRepo } from '../db/repositories/knownHostsRepo.js';
import type { RunsRepo } from '../db/repositories/runsRepo.js';
import { createSftpAdapterFromTransport } from '../transports/sftpAdapter.js';
import { createFtpAdapterFromTransport } from '../transports/ftpAdapter.js';
import { NoNewDumpAvailableError, type BackupStrategyContext, type BackupStrategyExecutor, type ProducedDump } from './types.js';

export function createFetchExistingExecutor(
  transport: Transport,
  secretStore: SecretStore,
  knownHosts: KnownHostsRepo,
  runsRepo: RunsRepo,
  onUnknownHost?: (presented: { keyType: string; fingerprintSha256: string }) => Promise<boolean>
): BackupStrategyExecutor {
  return {
    kind: 'fetch_existing',

    async produce(ctx: BackupStrategyContext): Promise<ProducedDump> {
      if (!ctx.task.remotePath) {
        throw new Error(`${transport.type} task is missing remotePath.`);
      }
      const filePattern = ctx.task.remoteFilePattern ? new RegExp(ctx.task.remoteFilePattern) : undefined;
      // fetch_existing supports either an sftp or an ftp transport -- both
      // are "connect, list, download the newest match" protocols; remote_dump
      // (ssh exec + download in one connection) has no FTP equivalent, since
      // FTP has no remote-command-execution concept at all.
      const adapter =
        transport.type === 'ftp'
          ? createFtpAdapterFromTransport(transport, secretStore)
          : createSftpAdapterFromTransport(transport, secretStore, knownHosts, onUnknownHost);

      await adapter.connect();
      try {
        const remoteFiles = await adapter.listRemoteFiles(ctx.task.remotePath, filePattern);
        if (remoteFiles.length === 0) {
          throw new Error(`No remote files found under ${ctx.task.remotePath}.`);
        }

        // Never redundantly re-download an existing, validated backup.
        // Matched by filename + size, not remote mtime alone — see the
        // remote-mtime trust caveat in the orchestrator.
        const alreadySuccessful = runsRepo.listSuccessfulFileSignatures(ctx.task.id);
        const isAlreadyDownloaded = (file: RemoteFile) =>
          alreadySuccessful.some((s) => s.remoteFileName === file.fileName && s.sizeBytes === file.size);

        const candidates = remoteFiles
          .filter((file) => !isAlreadyDownloaded(file))
          .sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());

        if (candidates.length === 0) {
          throw new NoNewDumpAvailableError('The latest remote backup is already downloaded and validated.');
        }

        const remote = candidates[0];
        const localTempPath = join(ctx.targetDir, `${remote.fileName}.part`);
        const result = await adapter.downloadFile(remote, localTempPath);

        return {
          localTempPath,
          fileName: remote.fileName,
          sizeBytes: result.bytesTransferred,
          sourceModifiedAt: remote.modifiedAt,
          checksumSha256: result.sha256,
        };
      } finally {
        await adapter.disconnect();
      }
    },
  };
}
