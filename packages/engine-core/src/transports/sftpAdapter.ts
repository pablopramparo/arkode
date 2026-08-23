import SftpClient from 'ssh2-sftp-client';
import { createWriteStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { KnownHostsRepo } from '../db/repositories/knownHostsRepo.js';
import type { SecretStore } from '../secrets/types.js';
import type { Transport } from '../types.js';
import { buildHostVerifier } from './hostKeyVerification.js';
import type {
  SftpAdapter,
  SftpTransportConfig,
  RemoteFile,
  DownloadResult,
  DownloadOptions,
  ConnectionTestResult,
} from './types.js';

/** Hashes bytes as they pass through, so downloading and checksumming cost one read, not two. */
class HashingProgressTransform extends Transform {
  private readonly hash = createHash('sha256');
  bytesTransferred = 0;

  constructor(
    private readonly total: number,
    private readonly onProgress?: (transferred: number, total: number) => void
  ) {
    super();
  }

  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.hash.update(chunk);
    this.bytesTransferred += chunk.length;
    this.onProgress?.(this.bytesTransferred, this.total);
    callback(null, chunk);
  }

  digestHex(): string {
    return this.hash.digest('hex');
  }
}

export function createSftpAdapter(config: SftpTransportConfig, knownHosts: KnownHostsRepo): SftpAdapter {
  // ssh2-sftp-client's default `error` callback logs low-level socket
  // events (e.g. ECONNRESET on a normal teardown) straight to console.error.
  // Those are expected noise around disconnect, not operational failures —
  // callers surface real failures via rejected promises, so this is a no-op.
  const client = new SftpClient(undefined, { error: () => {} });
  let connected = false;

  return {
    kind: 'sftp',

    async connect() {
      const privateKey = await readFile(config.privateKeyPath);
      await client.connect({
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
      await client.end();
      connected = false;
    },

    async testConnection(): Promise<ConnectionTestResult> {
      const startedAt = Date.now();
      try {
        await this.connect();
        await client.list(config.remotePath);
        await this.disconnect();
        return { ok: true, message: 'Connection succeeded.', latencyMs: Date.now() - startedAt };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    },

    async listRemoteFiles(remoteDir: string, pattern?: RegExp): Promise<RemoteFile[]> {
      const entries = await client.list(remoteDir);
      const baseDir = remoteDir.replace(/\/$/, '');
      return entries
        .filter((entry) => entry.type === '-')
        .filter((entry) => !pattern || pattern.test(entry.name))
        .map((entry) => ({
          remotePath: `${baseDir}/${entry.name}`,
          fileName: entry.name,
          size: entry.size,
          modifiedAt: new Date(entry.modifyTime),
        }));
    },

    async downloadFile(
      remote: RemoteFile,
      localTempPath: string,
      opts?: DownloadOptions
    ): Promise<DownloadResult> {
      const readStream = client.createReadStream(remote.remotePath);
      const hasher = new HashingProgressTransform(remote.size, opts?.onProgress);
      const writeStream = createWriteStream(localTempPath);
      await pipeline(readStream, hasher, writeStream, opts?.signal ? { signal: opts.signal } : {});
      return { bytesTransferred: hasher.bytesTransferred, sha256: hasher.digestHex() };
    },
  };
}

/**
 * Maps a `transports` row + resolved secret into an SftpAdapter. Shared by
 * the fetch_existing strategy executor and any ad-hoc "test connection"
 * caller (e.g. the CLI), so the transport -> adapter config mapping exists
 * in exactly one place.
 */
export function createSftpAdapterFromTransport(
  transport: Transport,
  secretStore: SecretStore,
  knownHosts: KnownHostsRepo,
  onUnknownHost?: (presented: { keyType: string; fingerprintSha256: string }) => Promise<boolean>
): SftpAdapter {
  if (transport.type !== 'sftp') {
    throw new Error(`Expected an sftp transport, got "${transport.type}".`);
  }
  if (!transport.remotePath) {
    throw new Error('SFTP transport is missing remotePath.');
  }

  const passphrase = transport.passphraseSecretRef
    ? (secretStore.get(transport.passphraseSecretRef) ?? undefined)
    : undefined;

  return createSftpAdapter(
    {
      host: transport.host,
      port: transport.port,
      username: transport.username,
      privateKeyPath: transport.privateKeyPath,
      passphrase,
      remotePath: transport.remotePath,
      remoteFilePattern: transport.remoteFilePattern ? new RegExp(transport.remoteFilePattern) : undefined,
      knownHostFingerprint: transport.knownHostFingerprint ?? undefined,
      onUnknownHost,
    },
    knownHosts
  );
}
