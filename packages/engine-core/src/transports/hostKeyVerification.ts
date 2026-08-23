import { createHash } from 'node:crypto';
import type { HostVerifier } from 'ssh2';
import type { KnownHostsRepo } from '../db/repositories/knownHostsRepo.js';

/**
 * The raw host key is in SSH wire format: a 4-byte big-endian length prefix
 * followed by the algorithm name (e.g. "ssh-ed25519"), then key material.
 * Parsing just the algorithm name lets known_hosts record a real key type
 * instead of a placeholder.
 */
function parseKeyType(rawKey: Buffer): string {
  if (rawKey.length < 4) return 'unknown';
  const nameLength = rawKey.readUInt32BE(0);
  if (nameLength <= 0 || 4 + nameLength > rawKey.length) return 'unknown';
  return rawKey.subarray(4, 4 + nameLength).toString('ascii');
}

/**
 * Shared hostVerifier builder for ssh2 / ssh2-sftp-client `connect()` config.
 * Never silently accepts an unknown host — the spec treats this as a
 * security priority, so it stays in scope for the vertical slice rather than
 * being deferred.
 */
export function buildHostVerifier(
  host: string,
  port: number,
  knownHosts: KnownHostsRepo,
  pinnedFingerprint: string | undefined,
  onUnknownHost?: (presented: { keyType: string; fingerprintSha256: string }) => Promise<boolean>
): HostVerifier {
  return (rawKey, verify) => {
    const fingerprint = createHash('sha256').update(rawKey).digest('base64');
    const keyType = parseKeyType(rawKey);

    if (pinnedFingerprint) {
      verify(pinnedFingerprint === fingerprint);
      return;
    }

    const existing = knownHosts.find(host, port);
    if (existing) {
      verify(existing.fingerprintSha256 === fingerprint);
      return;
    }

    if (!onUnknownHost) {
      verify(false);
      return;
    }

    onUnknownHost({ keyType, fingerprintSha256: fingerprint })
      .then((approved) => {
        if (approved) knownHosts.recordConfirmed(host, port, keyType, fingerprint);
        verify(approved);
      })
      .catch(() => verify(false));
  };
}
