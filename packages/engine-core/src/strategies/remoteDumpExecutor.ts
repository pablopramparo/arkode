import { join, posix } from 'node:path';
import type { BackupTask, Transport } from '../types.js';
import type { SecretStore } from '../secrets/types.js';
import type { KnownHostsRepo } from '../db/repositories/knownHostsRepo.js';
import { createSshAdapterFromTransport } from '../transports/sshAdapter.js';
import type { SshAdapter } from '../transports/types.js';
import { resolveOutputPathTemplate, applyRemoteCommandOutputPath } from '../transports/outputPathTemplate.js';
import { shellQuote } from '../transports/shellQuote.js';
import type { BackupStrategyContext, BackupStrategyExecutor, ProducedDump } from './types.js';

/**
 * Fixed path of the root-owned, allowlisting wrapper this app never
 * installs itself — see `ops/arkode-dump/` in the repo for the script and
 * setup instructions. arkode only ever knows how to *call* it; the wrapper
 * itself owns which containers/engines are permitted and how the actual
 * `docker exec` gets built, so a compromised or misconfigured arkode-backup
 * account can't be used to reach an arbitrary container. Deliberately not
 * `docker exec` directly, and deliberately not `docker` group membership
 * for the SSH user — see this app's own docs for the full reasoning.
 */
const DOCKER_WRAPPER_PATH = '/usr/local/sbin/arkode-dump';

/**
 * Builds the `sudo arkode-dump ...` invocation for a docker-mode remote_dump
 * task. Every value the user configured is shell-quoted individually —
 * never string-concatenated into a raw command — so a database/container
 * name containing shell metacharacters can't do anything beyond fail
 * cleanly. The DB password, when configured, deliberately does NOT appear
 * anywhere in this string: see produce()'s own comment on why it travels
 * over the SSH channel's stdin instead.
 */
export function buildDockerDumpCommand(task: BackupTask, resolvedOutputPath: string): string {
  return [
    `sudo ${DOCKER_WRAPPER_PATH}`,
    '--engine', task.dbEngine, // closed enum (postgres|mysql|mariadb), validated at task-creation time — safe to interpolate directly
    '--container', shellQuote(task.dockerContainer!),
    '--database', shellQuote(task.remoteDumpDatabase!),
    '--user', shellQuote(task.remoteDumpDbUser!),
    '>', shellQuote(resolvedOutputPath),
  ].join(' ');
}

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
 * Ensures the output path template's containing directory exists on the
 * remote host before remoteCommand runs — e.g. a template of
 * `/home/arkode-backup/rivera_web/dump_{date:...}.sql` no longer requires
 * the user's remoteCommand to itself `mkdir -p` that subfolder first. `mkdir
 * -p` is idempotent and a no-op when the directory already exists, so this
 * is safe to run unconditionally on every invocation. A bare filename with
 * no directory component resolves to "." via posix.dirname, which `mkdir
 * -p` also accepts harmlessly.
 */
async function ensureRemoteDirectoryExists(adapter: SshAdapter, remoteFilePath: string): Promise<void> {
  const dir = posix.dirname(remoteFilePath);
  const { exitCode, stderr } = await adapter.runCommand(`mkdir -p ${shellQuote(dir)}`);
  if (exitCode !== 0) {
    throw new Error(`Could not create remote directory "${dir}" before running the backup command.${stderr ? ` stderr: ${stderr}` : ''}`);
  }
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
      const dockerMode = ctx.task.remoteDumpExecMode === 'docker';
      if (!ctx.task.remoteOutputPathTemplate) {
        throw new Error('remote_dump task is missing remoteOutputPathTemplate.');
      }
      if (!dockerMode && !ctx.task.remoteCommand) {
        throw new Error('remote_dump task is missing remoteCommand.');
      }
      if (dockerMode && (!ctx.task.dockerContainer || !ctx.task.remoteDumpDatabase || !ctx.task.remoteDumpDbUser)) {
        throw new Error('remote_dump task with execMode "docker" is missing dockerContainer, remoteDumpDatabase, or remoteDumpDbUser.');
      }

      // Resolved once, up front, so a bad secret ref fails before ever
      // opening the SSH connection — matches direct_dump's own
      // resolve-before-connect ordering for the same reason.
      const dockerPassword = dockerMode && ctx.task.remoteDumpDbPasswordSecretRef
        ? secretStore.get(ctx.task.remoteDumpDbPasswordSecretRef)
        : undefined;

      const adapter = createSshAdapterFromTransport(transport, secretStore, knownHosts, onUnknownHost);

      await adapter.connect();
      try {
        // Queried right before running the remote command, so it reflects
        // the remote clock at essentially the same moment remoteCommand's
        // own $(date ...) will evaluate — see queryRemoteNow's doc comment.
        const remoteNow = await queryRemoteNow(adapter);
        const expectedRemotePath = resolveOutputPathTemplate(ctx.task.remoteOutputPathTemplate, remoteNow);

        // Resolved and created before remoteCommand runs, not after — the
        // whole point is that the user's remoteCommand can write straight to
        // a subfolder (e.g. one per database) without itself needing a
        // `mkdir -p` first. The extra round trip here is a sub-second add to
        // the gap queryRemoteNow's own doc comment already accepts as
        // negligible next to a real dump's multi-minute duration.
        await ensureRemoteDirectoryExists(adapter, expectedRemotePath);

        // Host mode: substitute {outputPath} in the user's command with the
        // exact path arkode resolved above, so there's one resolution, not
        // two independent ones that can drift apart (see
        // applyRemoteCommandOutputPath's doc comment). No placeholder ->
        // command passes through untouched.
        const command = dockerMode
          ? buildDockerDumpCommand(ctx.task, expectedRemotePath)
          : applyRemoteCommandOutputPath(ctx.task.remoteCommand!, expectedRemotePath);

        // The remote mysqldump/pg_dump gives no progress of its own — surface
        // it as an indeterminate phase so the UI shows "Generando dump en el
        // servidor…" instead of a frozen bar for what can be several minutes.
        ctx.reportProgress({ phase: 'remote_dump', fraction: null });
        // The password (when configured) travels only over this exec
        // channel's stdin, never as part of `command`'s own text — see
        // SshAdapter.runCommand's own doc comment for why that's the one
        // channel that never ends up in `ps aux`/`/proc/*/cmdline` on the
        // remote host. Host-mode tasks never pass stdin at all (undefined),
        // identical to this strategy's behavior before docker mode existed.
        const { exitCode, stdout, stderr } = await adapter.runCommand(
          command,
          dockerMode ? { stdin: dockerPassword ?? '' } : undefined
        );
        if (exitCode !== 0) {
          throw new Error(
            `Remote backup command exited with code ${exitCode}.${stderr ? ` stderr: ${stderr}` : ''}${stdout ? ` stdout: ${stdout}` : ''}`
          );
        }

        const remoteFile = await adapter.locateProducedFile(expectedRemotePath);

        const localTempPath = join(ctx.targetDir, `${remoteFile.fileName}.part`);
        const result = await adapter.downloadFile(remoteFile, localTempPath, {
          onProgress: (transferred, total) =>
            ctx.reportProgress({
              phase: 'downloading',
              fraction: total > 0 ? transferred / total : null,
              current: transferred,
              total: total > 0 ? total : undefined,
              unit: 'bytes',
            }),
        });

        if (result.bytesTransferred <= 0) {
          throw new Error(`Downloaded file "${remoteFile.fileName}" is empty (0 bytes).`);
        }

        // Per the spec's own ordering (verify the transfer, *then* optionally
        // clean up), cleanup happens only after a successful, non-empty
        // download — never before the local copy is confirmed present.
        if (ctx.task.remoteCleanup) {
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
