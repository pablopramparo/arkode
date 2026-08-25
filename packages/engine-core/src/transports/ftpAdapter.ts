import { Client, FileType } from 'basic-ftp';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import type { SecretStore } from '../secrets/types.js';
import type { Transport } from '../types.js';
import { HashingProgressTransform } from './hashingProgressTransform.js';
import type { FtpAdapter, FtpTransportConfig, RemoteFile, DownloadResult, DownloadOptions, ConnectionTestResult } from './types.js';

export function createFtpAdapter(config: FtpTransportConfig): FtpAdapter {
  const client = new Client();
  let connected = false;

  return {
    kind: 'ftp',

    async connect() {
      await client.access({
        host: config.host,
        port: config.port,
        user: config.username,
        password: config.password,
        // Plain FTP only, deliberately -- FTPS (secure: true) is a real,
        // separate protocol variant (TLS negotiation, cert trust) not asked
        // for here; revisit if a remote host actually needs it.
        secure: false,
      });
      connected = true;
    },

    async disconnect() {
      if (!connected) return;
      client.close();
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
        .filter((entry) => entry.type === FileType.File)
        .filter((entry) => !pattern || pattern.test(entry.name))
        .map((entry) => ({
          remotePath: `${baseDir}/${entry.name}`,
          fileName: entry.name,
          size: entry.size,
          // Only set when the server supports MLSD (see FileInfo's own doc
          // comment) -- falling back to "now" here is the same "best-effort,
          // never authoritative" treatment remote mtime already gets
          // everywhere else in this app (see the orchestrator's notes);
          // this never drives a real decision, just a display/sort hint.
          modifiedAt: entry.modifiedAt ?? new Date(),
        }));
    },

    async downloadFile(remote: RemoteFile, localTempPath: string, opts?: DownloadOptions): Promise<DownloadResult> {
      // basic-ftp's downloadTo() pushes data *into* the destination Writable
      // itself (unlike ssh2-sftp-client's createReadStream(), which hands
      // back a Readable to pipe from) -- passing the hasher (a Transform,
      // itself a Writable) as the destination, already piped to the real
      // file, gets the same "hash while streaming, one read pass" property
      // sftpAdapter.ts's pipeline() achieves the other way around.
      const hasher = new HashingProgressTransform(remote.size, opts?.onProgress);
      const writeStream = createWriteStream(localTempPath);
      const pipelineDone = pipeline(hasher, writeStream, opts?.signal ? { signal: opts.signal } : {});
      await client.downloadTo(hasher, remote.remotePath);
      await pipelineDone;
      return { bytesTransferred: hasher.bytesTransferred, sha256: hasher.digestHex() };
    },
  };
}

/**
 * Maps a `transports` row + resolved secret into an FtpAdapter. Mirrors
 * createSftpAdapterFromTransport's role for the sftp/ssh side.
 */
export function createFtpAdapterFromTransport(transport: Transport, secretStore: SecretStore): FtpAdapter {
  if (transport.type !== 'ftp') {
    throw new Error(`Expected an ftp transport, got "${transport.type}".`);
  }
  if (!transport.remotePath) {
    throw new Error('FTP transport is missing remotePath.');
  }

  const password = transport.passwordSecretRef ? (secretStore.get(transport.passwordSecretRef) ?? undefined) : undefined;

  return createFtpAdapter({
    host: transport.host,
    port: transport.port,
    username: transport.username,
    password,
    remotePath: transport.remotePath,
    remoteFilePattern: transport.remoteFilePattern ? new RegExp(transport.remoteFilePattern) : undefined,
  });
}
