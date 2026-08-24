import { Client, type SFTPWrapper } from 'ssh2';
import { createWriteStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { KnownHostsRepo } from '../db/repositories/knownHostsRepo.js';
import type { SecretStore } from '../secrets/types.js';
import type { Transport } from '../types.js';
import { buildHostVerifier } from './hostKeyVerification.js';
import { HashingProgressTransform } from './hashingProgressTransform.js';
import type {
  SshAdapter,
  SshTransportConfig,
  RemoteFile,
  DownloadResult,
  DownloadOptions,
  ConnectionTestResult,
} from './types.js';

function connectClient(client: Client, connectConfig: Parameters<Client['connect']>[0]): Promise<void> {
  return new Promise((resolve, reject) => {
    const onReady = () => {
      client.removeListener('error', onError);
      resolve();
    };
    const onError = (err: Error) => {
      client.removeListener('ready', onReady);
      reject(err);
    };
    client.once('ready', onReady).once('error', onError).connect(connectConfig);
  });
}

function execOnce(
  client: Client,
  command: string,
  timeoutMs?: number
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) return reject(err);

      let stdout = '';
      let stderr = '';
      const timer = timeoutMs
        ? setTimeout(() => {
            stream.destroy();
            reject(new Error(`Remote command timed out after ${timeoutMs}ms: ${command}`));
          }, timeoutMs)
        : undefined;

      stream
        .on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8');
        })
        .on('close', (code: number | null) => {
          if (timer) clearTimeout(timer);
          resolve({ exitCode: code ?? -1, stdout, stderr });
        })
        .stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8');
        });
    });
  });
}

function sftpOf(client: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)));
  });
}

function statOf(sftp: SFTPWrapper, path: string): Promise<{ size: number; mtime: number }> {
  return new Promise((resolve, reject) => {
    sftp.stat(path, (err, stats) => (err ? reject(err) : resolve({ size: stats.size, mtime: stats.mtime })));
  });
}

function unlinkOf(sftp: SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.unlink(path, (err) => (err ? reject(err) : resolve()));
  });
}

export function createSshAdapter(config: SshTransportConfig, knownHosts: KnownHostsRepo): SshAdapter {
  const client = new Client();
  // ssh2's Client is a plain EventEmitter: a socket-level error (e.g.
  // ECONNRESET after a host-verification rejection tears down the
  // connection) with no 'error' listener attached crashes the whole
  // process. connectClient()'s once-listener only covers the connect
  // window, so a permanent no-op listener is needed for the rest of the
  // adapter's lifetime; real connect failures are still surfaced via the
  // rejected connect()/exec() promises below, not through this listener.
  client.on('error', () => {});
  let connected = false;

  return {
    kind: 'ssh',

    async connect() {
      const privateKey = await readFile(config.privateKeyPath);
      await connectClient(client, {
        host: config.host,
        port: config.port,
        username: config.username,
        privateKey,
        passphrase: config.passphrase,
        hostVerifier: buildHostVerifier(
          config.host,
          config.port,
          knownHosts,
          config.knownHostFingerprint,
          config.onUnknownHost
        ),
      });
      connected = true;
    },

    async disconnect() {
      if (!connected) return;
      client.end();
      connected = false;
    },

    async testConnection(): Promise<ConnectionTestResult> {
      const startedAt = Date.now();
      try {
        await this.connect();
        const { exitCode, stderr } = await execOnce(client, 'echo codebius_connection_test_ok', 10_000);
        await this.disconnect();
        if (exitCode !== 0) {
          return { ok: false, message: `Remote echo command exited with code ${exitCode}: ${stderr}` };
        }
        return { ok: true, message: 'Connection succeeded.', latencyMs: Date.now() - startedAt };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    },

    async runCommand(command: string, opts?: { timeoutMs?: number }) {
      return execOnce(client, command, opts?.timeoutMs);
    },

    async locateProducedFile(expectedRemotePath: string): Promise<RemoteFile> {
      const sftp = await sftpOf(client);
      const stats = await statOf(sftp, expectedRemotePath);
      return {
        remotePath: expectedRemotePath,
        fileName: basename(expectedRemotePath),
        size: stats.size,
        modifiedAt: new Date(stats.mtime * 1000),
      };
    },

    async removeRemoteFile(remotePath: string): Promise<void> {
      const sftp = await sftpOf(client);
      await unlinkOf(sftp, remotePath);
    },

    async downloadFile(
      remote: RemoteFile,
      localTempPath: string,
      opts?: DownloadOptions
    ): Promise<DownloadResult> {
      const sftp = await sftpOf(client);
      const readStream = sftp.createReadStream(remote.remotePath);
      const hasher = new HashingProgressTransform(remote.size, opts?.onProgress);
      const writeStream = createWriteStream(localTempPath);
      await pipeline(readStream, hasher, writeStream, opts?.signal ? { signal: opts.signal } : {});
      return { bytesTransferred: hasher.bytesTransferred, sha256: hasher.digestHex() };
    },
  };
}

/** Maps a `transports` row + resolved secret into an SshAdapter, mirroring createSftpAdapterFromTransport. */
export function createSshAdapterFromTransport(
  transport: Transport,
  secretStore: SecretStore,
  knownHosts: KnownHostsRepo,
  onUnknownHost?: (presented: { keyType: string; fingerprintSha256: string }) => Promise<boolean>
): SshAdapter {
  if (transport.type !== 'ssh') {
    throw new Error(`Expected an ssh transport, got "${transport.type}".`);
  }
  if (!transport.remoteCommand || !transport.remoteOutputPathTemplate) {
    throw new Error('SSH transport is missing remoteCommand or remoteOutputPathTemplate.');
  }

  const passphrase = transport.passphraseSecretRef
    ? (secretStore.get(transport.passphraseSecretRef) ?? undefined)
    : undefined;

  return createSshAdapter(
    {
      host: transport.host,
      port: transport.port,
      username: transport.username,
      privateKeyPath: transport.privateKeyPath,
      passphrase,
      remoteCommand: transport.remoteCommand,
      remoteOutputPathTemplate: transport.remoteOutputPathTemplate,
      remoteCleanup: transport.remoteCleanup,
      knownHostFingerprint: transport.knownHostFingerprint ?? undefined,
      onUnknownHost,
    },
    knownHosts
  );
}
