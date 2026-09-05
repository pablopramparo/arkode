import { createHash } from 'node:crypto';
import { Client, type ServerHostKeyAlgorithm } from 'ssh2';
import { parseKeyType } from '../transports/hostKeyVerification.js';

export interface SftpHostKeyEntry {
  keyType: string;
  base64Key: string;
  fingerprintSha256: string;
}

export interface SftpHostKeyCaptureResult {
  /** One real OpenSSH known_hosts line per distinct key algorithm found, newline-joined. */
  knownHostsContent: string;
  entries: SftpHostKeyEntry[];
}

/**
 * Every server host key algorithm ssh2 knows how to negotiate. rsa-sha2-512
 * /rsa-sha2-256 are signature-algorithm variants of the same RSA key (RFC
 * 8332) -- probing them separately from ssh-rsa is necessary because a
 * modern OpenSSH server may reject a bare "ssh-rsa" negotiation outright
 * while still offering the same key under the newer signature names
 * (confirmed by hand against this app's own test sshd); all three resolve
 * back to keyType "ssh-rsa" once parsed, and are deduped below.
 */
const CANDIDATE_ALGORITHMS: ServerHostKeyAlgorithm[] = [
  'ssh-ed25519',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'rsa-sha2-512',
  'rsa-sha2-256',
  'ssh-rsa',
  'ssh-dss',
];

function captureOneAlgorithm(
  host: string,
  port: number,
  algorithm: ServerHostKeyAlgorithm,
  timeoutMs: number
): Promise<SftpHostKeyEntry> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let settled = false;
    const timer = setTimeout(() => {
      finish(() => reject(new Error(`Timed out probing ${algorithm} for ${host}:${port}.`)));
    }, timeoutMs);

    function finish(fn: () => void) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        client.end();
      } catch {
        /* already closing */
      }
      fn();
    }

    // Plain EventEmitter -- an unhandled 'error' (e.g. this algorithm isn't
    // supported by the server, or the dummy auth below gets rejected) would
    // otherwise crash the process. Once captured, any later error is
    // expected and ignored via the `settled` guard in finish().
    client.on('error', (err) => finish(() => reject(err)));

    client.connect({
      host,
      port,
      // No real credentials needed -- the host key is presented during the
      // transport-layer handshake, before any authentication attempt.
      username: 'arkode-host-key-probe',
      password: '',
      readyTimeout: timeoutMs,
      algorithms: { serverHostKey: [algorithm] },
      hostVerifier: (rawKey: Buffer, verify: (valid: boolean) => void) => {
        const keyType = parseKeyType(rawKey);
        const fingerprintSha256 = createHash('sha256').update(rawKey).digest('base64');
        const base64Key = rawKey.toString('base64');
        verify(true); // deliberate TOFU capture -- this call's only purpose is to see the key.
        finish(() => resolve({ keyType, base64Key, fingerprintSha256 }));
      },
    });
  });
}

/**
 * Captures every SSH host key algorithm a server supports, purely so they
 * can be pinned for rclone's own sftp backend -- which, unlike this app's
 * ssh2-based transports (buildHostVerifier's TOFU-with-confirmation flow),
 * does NOT verify the remote host's key at all by default (confirmed
 * against rclone's docs), and whose real vendored version here has no
 * inline "host_keys"/"pin_host_key" option (confirmed against `rclone help
 * backend sftp` -- only `known_hosts_file` exists). A single-algorithm
 * capture is not reliable: rclone's Go SSH client and this function's own
 * ssh2 client don't necessarily negotiate the same key type when a server
 * offers several, so every algorithm the server accepts is captured and
 * written as a real OpenSSH known_hosts line -- confirmed against a real
 * server that whichever algorithm rclone actually negotiates, a matching
 * entry is present.
 *
 * Each candidate is probed concurrently (a short-lived, auth-free
 * connection restricted to one algorithm via ssh2's
 * `algorithms.serverHostKey`); one the server doesn't support simply fails
 * to negotiate and is skipped.
 */
export async function captureSftpHostKeys(opts: {
  host: string;
  port: number;
  timeoutMs?: number;
}): Promise<SftpHostKeyCaptureResult> {
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const settled = await Promise.allSettled(
    CANDIDATE_ALGORITHMS.map((algorithm) => captureOneAlgorithm(opts.host, opts.port, algorithm, timeoutMs))
  );

  const found = new Map<string, SftpHostKeyEntry>();
  for (const result of settled) {
    if (result.status === 'fulfilled' && !found.has(result.value.keyType)) {
      found.set(result.value.keyType, result.value);
    }
  }

  if (found.size === 0) {
    throw new Error(
      `Could not determine ${opts.host}:${opts.port}'s SSH host key -- the server may be unreachable, or use no supported key algorithm.`
    );
  }

  const entries = [...found.values()];
  const hostField = opts.port === 22 ? opts.host : `[${opts.host}]:${opts.port}`;
  const knownHostsContent = entries.map((e) => `${hostField} ${e.keyType} ${e.base64Key}`).join('\n') + '\n';
  return { knownHostsContent, entries };
}

/** "algo fingerprint" pairs joined for display, e.g. in the replication UI. */
export function formatHostKeyFingerprints(entries: SftpHostKeyEntry[]): string {
  return entries.map((e) => `${e.keyType} ${e.fingerprintSha256}`).join('; ');
}
