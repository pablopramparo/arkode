import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildHostVerifier } from '../../src/transports/hostKeyVerification.js';
import type { KnownHostsRepo } from '../../src/db/repositories/knownHostsRepo.js';
import type { HostVerifier } from 'ssh2';

function buildRawKey(keyType: string, material = 'key-material'): Buffer {
  const typeBuf = Buffer.from(keyType, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(typeBuf.length, 0);
  return Buffer.concat([lenBuf, typeBuf, Buffer.from(material)]);
}

function fingerprintOf(rawKey: Buffer): string {
  return createHash('sha256').update(rawKey).digest('base64');
}

function callVerifier(verifier: HostVerifier, rawKey: Buffer): Promise<boolean> {
  return new Promise((resolve) => verifier(rawKey, resolve));
}

function createFakeKnownHostsRepo(): KnownHostsRepo {
  const records = new Map<string, { fingerprintSha256: string; keyType: string }>();
  return {
    find(host, port) {
      const record = records.get(`${host}:${port}`);
      if (!record) return null;
      return {
        id: 'fake',
        host,
        port,
        keyType: record.keyType,
        fingerprintSha256: record.fingerprintSha256,
        firstSeenAt: new Date().toISOString(),
        confirmedAt: new Date().toISOString(),
      };
    },
    recordConfirmed(host, port, keyType, fingerprintSha256) {
      records.set(`${host}:${port}`, { fingerprintSha256, keyType });
      return {
        id: 'fake',
        host,
        port,
        keyType,
        fingerprintSha256,
        firstSeenAt: new Date().toISOString(),
        confirmedAt: new Date().toISOString(),
      };
    },
  };
}

describe('buildHostVerifier', () => {
  const rawKey = buildRawKey('ssh-ed25519');
  const fingerprint = fingerprintOf(rawKey);

  it('accepts when the presented key matches a pinned fingerprint', async () => {
    const knownHosts = createFakeKnownHostsRepo();
    const verifier = buildHostVerifier('host', 22, knownHosts, fingerprint, undefined);
    await expect(callVerifier(verifier, rawKey)).resolves.toBe(true);
  });

  it('rejects when the presented key does not match a pinned fingerprint', async () => {
    const knownHosts = createFakeKnownHostsRepo();
    const verifier = buildHostVerifier('host', 22, knownHosts, 'some-other-fingerprint', undefined);
    await expect(callVerifier(verifier, rawKey)).resolves.toBe(false);
  });

  it('accepts when the presented key matches a previously-recorded known host', async () => {
    const knownHosts = createFakeKnownHostsRepo();
    knownHosts.recordConfirmed('host', 22, 'ssh-ed25519', fingerprint);
    const verifier = buildHostVerifier('host', 22, knownHosts, undefined, undefined);
    await expect(callVerifier(verifier, rawKey)).resolves.toBe(true);
  });

  it('rejects when the known host record has a different fingerprint (key changed)', async () => {
    const knownHosts = createFakeKnownHostsRepo();
    knownHosts.recordConfirmed('host', 22, 'ssh-ed25519', 'a-completely-different-fingerprint');
    const verifier = buildHostVerifier('host', 22, knownHosts, undefined, undefined);
    await expect(callVerifier(verifier, rawKey)).resolves.toBe(false);
  });

  it('rejects an unknown host with no confirmation callback — never silently accepts', async () => {
    const knownHosts = createFakeKnownHostsRepo();
    const verifier = buildHostVerifier('host', 22, knownHosts, undefined, undefined);
    await expect(callVerifier(verifier, rawKey)).resolves.toBe(false);
  });

  it('accepts an unknown host when the confirmation callback approves it, and records it', async () => {
    const knownHosts = createFakeKnownHostsRepo();
    const verifier = buildHostVerifier('host', 22, knownHosts, undefined, async () => true);
    await expect(callVerifier(verifier, rawKey)).resolves.toBe(true);

    // Recorded with the correct parsed key type and fingerprint, so a
    // second connection to the same host trusts it without re-prompting.
    const secondVerifier = buildHostVerifier('host', 22, knownHosts, undefined, undefined);
    await expect(callVerifier(secondVerifier, rawKey)).resolves.toBe(true);
  });

  it('rejects an unknown host when the confirmation callback declines it, and does not record it', async () => {
    const knownHosts = createFakeKnownHostsRepo();
    const verifier = buildHostVerifier('host', 22, knownHosts, undefined, async () => false);
    await expect(callVerifier(verifier, rawKey)).resolves.toBe(false);
    expect(knownHosts.find('host', 22)).toBeNull();
  });

  it('rejects (rather than throwing) when the confirmation callback itself rejects', async () => {
    const knownHosts = createFakeKnownHostsRepo();
    const verifier = buildHostVerifier('host', 22, knownHosts, undefined, async () => {
      throw new Error('user cancelled');
    });
    await expect(callVerifier(verifier, rawKey)).resolves.toBe(false);
  });

  // onUnknownHostPresented: lets a caller that can't do an interactive
  // terminal prompt (the UI, via serve) still learn what was presented so
  // it can offer its own "trust this host?" flow — see
  // ConnectionTestResult.unknownHost.
  it('fires onUnknownHostPresented for an unrecognized host, with no confirmation callback at all', async () => {
    const knownHosts = createFakeKnownHostsRepo();
    let presented: { keyType: string; fingerprintSha256: string } | undefined;
    const verifier = buildHostVerifier('host', 22, knownHosts, undefined, undefined, (p) => (presented = p));
    await callVerifier(verifier, rawKey);
    expect(presented).toEqual({ keyType: 'ssh-ed25519', fingerprintSha256: fingerprint });
  });

  it('fires onUnknownHostPresented even when the confirmation callback declines', async () => {
    const knownHosts = createFakeKnownHostsRepo();
    let presented: { keyType: string; fingerprintSha256: string } | undefined;
    const verifier = buildHostVerifier('host', 22, knownHosts, undefined, async () => false, (p) => (presented = p));
    await callVerifier(verifier, rawKey);
    expect(presented?.fingerprintSha256).toBe(fingerprint);
  });

  it('does not fire onUnknownHostPresented for a pinned or already-known host', async () => {
    const knownHosts = createFakeKnownHostsRepo();
    knownHosts.recordConfirmed('host', 22, 'ssh-ed25519', fingerprint);
    let fired = false;
    const verifier = buildHostVerifier('host', 22, knownHosts, undefined, undefined, () => (fired = true));
    await callVerifier(verifier, rawKey);
    expect(fired).toBe(false);
  });

  // Regression: a host already in known_hosts whose presented key no longer
  // matches (the server's host key rotated, e.g. after a reprovision) used to
  // fall straight to verify(false) without ever calling onUnknownHostPresented
  // — the caller had no way to learn *what* changed, so a caller like the UI
  // (which can't do an interactive terminal prompt) had nothing to show
  // besides the raw ssh2 "Host denied (verification failed)" error, with no
  // path to resolve it. This must go through the same presented/confirm flow
  // as a genuinely new host, carrying the old fingerprint for context.
  it('fires onUnknownHostPresented (with previousFingerprintSha256) when a known host presents a different key', async () => {
    const knownHosts = createFakeKnownHostsRepo();
    knownHosts.recordConfirmed('host', 22, 'ssh-ed25519', 'the-old-fingerprint');
    let presented: { keyType: string; fingerprintSha256: string; previousFingerprintSha256?: string } | undefined;
    const verifier = buildHostVerifier('host', 22, knownHosts, undefined, undefined, (p) => (presented = p));
    await callVerifier(verifier, rawKey);
    expect(presented).toEqual({
      keyType: 'ssh-ed25519',
      fingerprintSha256: fingerprint,
      previousFingerprintSha256: 'the-old-fingerprint',
    });
  });

  it('accepts a rotated host key when the confirmation callback approves it, and updates the stored fingerprint', async () => {
    const knownHosts = createFakeKnownHostsRepo();
    knownHosts.recordConfirmed('host', 22, 'ssh-ed25519', 'the-old-fingerprint');
    const verifier = buildHostVerifier('host', 22, knownHosts, undefined, async () => true);
    await expect(callVerifier(verifier, rawKey)).resolves.toBe(true);

    // A later connection with the new key is now trusted without re-prompting.
    const secondVerifier = buildHostVerifier('host', 22, knownHosts, undefined, undefined);
    await expect(callVerifier(secondVerifier, rawKey)).resolves.toBe(true);
  });

  it('does not pass a previousFingerprintSha256 for a genuinely never-seen host', async () => {
    const knownHosts = createFakeKnownHostsRepo();
    let presented: { keyType: string; fingerprintSha256: string; previousFingerprintSha256?: string } | undefined;
    const verifier = buildHostVerifier('host', 22, knownHosts, undefined, undefined, (p) => (presented = p));
    await callVerifier(verifier, rawKey);
    expect(presented?.previousFingerprintSha256).toBeUndefined();
  });
});
