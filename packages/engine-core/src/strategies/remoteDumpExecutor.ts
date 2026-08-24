import { join } from 'node:path';
import type { Transport } from '../types.js';
import type { SecretStore } from '../secrets/types.js';
import type { KnownHostsRepo } from '../db/repositories/knownHostsRepo.js';
import { createSshAdapterFromTransport } from '../transports/sshAdapter.js';
import { resolveOutputPathTemplate } from '../transports/outputPathTemplate.js';
import type { BackupStrategyContext, BackupStrategyExecutor, ProducedDump } from './types.js';

/**
 * Generates the backup on the remote host via a configured SSH command, then
 * downloads it. Every invocation legitimately produces a fresh remote file
 * (the output path template includes a date token), so unlike
 * fetch_existing there is no "already downloaded" case to detect.
 */
export function createRemoteDumpExecutor(
  transport: Transport,
  secretStore: SecretStore,
  knownHosts: KnownHostsRepo,
  onUnknownHost?: (presented: { keyType: string; fingerprintSha256: string }) => Promise<boolean>
): BackupStrategyExecutor {
  return {
    kind: 'remote_dump',

    async produce(ctx: BackupStrategyContext): Promise<ProducedDump> {
      if (!transport.remoteCommand || !transport.remoteOutputPathTemplate) {
        throw new Error('SSH transport is missing remoteCommand or remoteOutputPathTemplate.');
      }

      const adapter = createSshAdapterFromTransport(transport, secretStore, knownHosts, onUnknownHost);

      await adapter.connect();
      try {
        const { exitCode, stdout, stderr } = await adapter.runCommand(transport.remoteCommand);
        if (exitCode !== 0) {
          throw new Error(
            `Remote backup command exited with code ${exitCode}.${stderr ? ` stderr: ${stderr}` : ''}${stdout ? ` stdout: ${stdout}` : ''}`
          );
        }

        const expectedRemotePath = resolveOutputPathTemplate(transport.remoteOutputPathTemplate);
        const remoteFile = await adapter.locateProducedFile(expectedRemotePath);

        const localTempPath = join(ctx.targetDir, `${remoteFile.fileName}.part`);
        const result = await adapter.downloadFile(remoteFile, localTempPath);

        if (result.bytesTransferred <= 0) {
          throw new Error(`Downloaded file "${remoteFile.fileName}" is empty (0 bytes).`);
        }

        // Per the spec's own ordering (verify the transfer, *then* optionally
        // clean up), cleanup happens only after a successful, non-empty
        // download — never before the local copy is confirmed present.
        if (transport.remoteCleanup) {
          await adapter.removeRemoteFile(expectedRemotePath);
        }

        return {
          localTempPath,
          fileName: remoteFile.fileName,
          sizeBytes: result.bytesTransferred,
          sourceModifiedAt: remoteFile.modifiedAt,
          checksumSha256: result.sha256,
        };
      } finally {
        await adapter.disconnect();
      }
    },
  };
}
