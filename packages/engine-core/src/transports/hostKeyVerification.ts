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
  onUnknownHost?: (presented: {
    keyType: string;
    fingerprintSha256: string;
    previousFingerprintSha256?: string;
  }) => Promise<boolean>,
  /**
   * Fired whenever the presented key isn't already trusted — either a
   * genuinely never-seen host, or one already in known_hosts whose stored
   * fingerprint no longer matches (the server's host key rotated, e.g. after
   * a reprovision) — regardless of what onUnknownHost decides, or whether one
   * was even supplied. Lets a caller that can't do an interactive prompt (see
   * ConnectionTestResult.unknownHost) still learn what was presented, so it
   * can offer its own "trust this host?" flow instead of just seeing a
   * generic rejected connection. A previously-known host whose key changed
   * carries previousFingerprintSha256, so the caller can warn more strongly
   * than for a first-time trust (this is exactly the case a real ssh client
   * screams about, since it can also mean a MITM, not just a reprovision).
   */
  onUnknownHostPresented?: (presented: {
    keyType: string;
    fingerprintSha256: string;
    previousFingerprintSha256?: string;
  }) => void
): HostVerifier {
  return (rawKey, verify) => {
    const fingerprint = createHash('sha256').update(rawKey).digest('base64');
    const keyType = parseKeyType(rawKey);

    if (pinnedFingerprint) {
      verify(pinnedFingerprint === fingerprint);
      return;
    }

    const existing = knownHosts.find(host, port);
    if (existing && existing.fingerprintSha256 === fingerprint) {
      verify(true);
      return;
    }

    const previousFingerprintSha256 = existing ? existing.fingerprintSha256 : undefined;
    onUnknownHostPresented?.({ keyType, fingerprintSha256: fingerprint, previousFingerprintSha256 });

    if (!onUnknownHost) {
      verify(false);
      return;
    }

    onUnknownHost({ keyType, fingerprintSha256: fingerprint, previousFingerprintSha256 })
      .then((approved) => {
        if (approved) knownHosts.recordConfirmed(host, port, keyType, fingerprint);
        verify(approved);
      })
      .catch(() => verify(false));
  };
}

/**
 * Builds a clear, actionable message for a connect() failure caused
 * specifically by an untrusted host key — replacing ssh2's own opaque "Host
 * denied (verification failed)". Used on the "Ejecutar ahora"/scheduled-run
 * path, which never offers a trust-and-retry option itself (trust is only
 * ever established explicitly, via a connection test) — so the person
 * seeing this needs to know *why* it failed and where to go fix it, not
 * just that it failed.
 */
export function describeUnknownHostError(presented: {
  keyType: string;
  fingerprintSha256: string;
  previousFingerprintSha256?: string;
}): string {
  const where = 'Test the connection (from Conexiones, or the task\'s own "Probar conexión") and trust it there before running this task.';
  if (presented.previousFingerprintSha256) {
    return (
      `This host's SSH key changed since it was last trusted (now ${presented.keyType} ${presented.fingerprintSha256}, ` +
      `was ${presented.previousFingerprintSha256}). This can be routine (the server was reprovisioned) or a real security ` +
      `concern — confirm with whoever administers it before trusting the new key. ${where}`
    );
  }
  return `This host's SSH key (${presented.keyType} ${presented.fingerprintSha256}) isn't trusted yet. ${where}`;
}
