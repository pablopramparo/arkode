import { describe, expect, it } from 'vitest';
import { captureSftpHostKeys, formatHostKeyFingerprints } from '../../src/replication/sftpHostKeyCapture.js';

/**
 * Real-network-gated, same explicit-opt-in precedent as RESTIC_PATH gating
 * resticClient.spec.ts's real-restic suite: self-skips on a clean
 * checkout/CI runner with no real sshd to test against, but this was
 * explicitly run with ARKODE_TEST_SSHD=127.0.0.1:22 against this dev
 * machine's real local OpenSSH server to confirm the capture mechanism for
 * real -- see the plan's design notes for the full hand-verification
 * against a real vendored rclone.exe (which is what actually motivated the
 * multi-algorithm-probe design this exercises).
 */
const target = process.env.ARKODE_TEST_SSHD;
const [host, portStr] = target?.split(':') ?? [];
const port = portStr ? Number(portStr) : 22;

describe.skipIf(!host)('captureSftpHostKeys (real local sshd)', () => {
  it('finds at least one real host key, well-formed as a known_hosts line', async () => {
    const result = await captureSftpHostKeys({ host, port });
    expect(result.entries.length).toBeGreaterThan(0);
    for (const entry of result.entries) {
      expect(entry.keyType).toMatch(/^(ssh-ed25519|ecdsa-sha2-nistp\d+|ssh-rsa|ssh-dss)$/);
      expect(entry.base64Key.length).toBeGreaterThan(0);
      expect(entry.fingerprintSha256.length).toBeGreaterThan(0);
    }
    const lines = result.knownHostsContent.trim().split('\n');
    expect(lines).toHaveLength(result.entries.length);
    for (const line of lines) {
      const parts = line.split(' ');
      expect(parts).toHaveLength(3);
      expect(parts[0]).toBe(host);
    }
  });

  it('formatHostKeyFingerprints renders one "algo fingerprint" pair per entry', async () => {
    const result = await captureSftpHostKeys({ host, port });
    const formatted = formatHostKeyFingerprints(result.entries);
    for (const entry of result.entries) {
      expect(formatted).toContain(`${entry.keyType} ${entry.fingerprintSha256}`);
    }
  });

  it('rejects when nothing is listening on the given port', async () => {
    await expect(captureSftpHostKeys({ host, port: 1, timeoutMs: 1500 })).rejects.toThrow();
  });
});
