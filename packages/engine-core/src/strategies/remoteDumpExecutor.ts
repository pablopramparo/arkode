import { join } from 'node:path';
import type { Transport } from '../types.js';
import type { SecretStore } from '../secrets/types.js';
import type { KnownHostsRepo } from '../db/repositories/knownHostsRepo.js';
import { createSshAdapterFromTransport } from '../transports/sshAdapter.js';
import type { SshAdapter } from '../transports/types.js';
import { resolveOutputPathTemplate } from '../transports/outputPathTemplate.js';
import type { BackupStrategyContext, BackupStrategyExecutor, ProducedDump } from './types.js';

/**
 * Asks the remote host what time it thinks it is, rather than trusting the
 * local machine's clock to agree — found necessary via a real "No such
 * file" failure where a remote VPS's system clock (no NTP running) was
 * measured ~100 seconds ahead of this PC's. remoteCommand's own embedded
 * `$(date ...)` token is evaluated by the *remote* shell, so the {date:...}
 * token in remoteOutputPathTemplate must be resolved against that same
 * remote clock, not the local one — any persistent drift between the two
 * machines would otherwise make the locally-resolved filename never match
 * what the remote shell actually produced, regardless of how precisely the
 * local timestamp is captured. Best-effort: if the `date` command itself
 * fails for some reason, falls back to local time rather than failing the
 * whole backup over a diagnostic step.
 */
async function queryRemoteNow(adapter: SshAdapter): Promise<Date> {
  const { exitCode, stdout } = await adapter.runCommand('date +%s');
  if (exitCode !== 0) return new Date();
  const epochSeconds = Number.parseInt(stdout.trim(), 10);
  return Number.isFinite(epochSeconds) ? new Date(epochSeconds * 1000) : new Date();
}

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
        // Queried right before running the remote command, so it reflects
        // the remote clock at essentially the same moment remoteCommand's
        // own $(date ...) will evaluate — see queryRemoteNow's doc comment.
        const remoteNow = await queryRemoteNow(adapter);
        const { exitCode, stdout, stderr } = await adapter.runCommand(transport.remoteCommand);
        if (exitCode !== 0) {
          throw new Error(
            `Remote backup command exited with code ${exitCode}.${stderr ? ` stderr: ${stderr}` : ''}${stdout ? ` stdout: ${stdout}` : ''}`
          );
        }

        const expectedRemotePath = resolveOutputPathTemplate(transport.remoteOutputPathTemplate, remoteNow);
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
