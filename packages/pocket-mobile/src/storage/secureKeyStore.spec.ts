/**
 * `react-native-keychain` is a native module with no real Android/iOS host
 * in this test environment — mocked here with a plain in-memory Map so this
 * suite proves this file's OWN logic (JSON shape, base64 round-trip, "never
 * throw the user into a crash on a corrupted item") without needing a real
 * device. The actual OS-level guarantees (biometric gating, THIS_DEVICE_ONLY
 * exclusion from iCloud Keychain sync, BIOMETRY_CURRENT_SET invalidation on
 * re-enrollment) are `react-native-keychain`'s own responsibility and can
 * only be verified on a real device — see docs/pocket.md.
 */
let store = new Map<string, string>();

jest.mock('react-native-keychain', () => ({
  ACCESSIBLE: { WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY' },
  ACCESS_CONTROL: { BIOMETRY_CURRENT_SET_OR_DEVICE_PASSCODE: 'BIOMETRY_CURRENT_SET_OR_DEVICE_PASSCODE' },
  hasGenericPassword: jest.fn(async ({ service }: { service: string }) => store.has(service)),
  setGenericPassword: jest.fn(async (_username: string, password: string, opts: { service: string }) => {
    store.set(opts.service, password);
    return { service: opts.service, storage: 'fake' };
  }),
  getGenericPassword: jest.fn(async ({ service }: { service: string }) => {
    const password = store.get(service);
    return password ? { service, username: 'arkode-pocket', password, storage: 'fake' } : false;
  }),
  resetGenericPassword: jest.fn(async ({ service }: { service: string }) => {
    store.delete(service);
    return true;
  }),
}));

import { hasStoredPairing, savePairing, loadPairing, clearPairing, looksLikeBiometricInvalidation } from './secureKeyStore';

const SAMPLE_DEK = new Uint8Array(32).fill(5);

beforeEach(() => {
  store = new Map();
});

describe('secureKeyStore', () => {
  it('reports no pairing before one is saved', async () => {
    expect(await hasStoredPairing()).toBe(false);
    expect(await loadPairing('x')).toBeNull();
  });

  it('round-trips a pairing exactly, including the raw DEK bytes', async () => {
    await savePairing({ pocketId: 'p1', dek: SAMPLE_DEK, driveRemotePath: 'Arkode/Pocket', driveFileId: 'file-1' });
    expect(await hasStoredPairing()).toBe(true);
    const loaded = await loadPairing('Desbloqueá Arkode Pocket');
    expect(loaded?.pocketId).toBe('p1');
    expect(loaded?.driveRemotePath).toBe('Arkode/Pocket');
    expect(loaded?.driveFileId).toBe('file-1');
    expect(Buffer.from(loaded!.dek).equals(Buffer.from(SAMPLE_DEK))).toBe(true);
  });

  it('never persists anything outside the one JSON blob — the underlying store literally cannot hold a second field', async () => {
    await savePairing({ pocketId: 'p1', dek: SAMPLE_DEK, driveRemotePath: 'Arkode/Pocket', driveFileId: null });
    expect(store.size).toBe(1);
  });

  it('treats a corrupted stored item as "no pairing", not a crash', async () => {
    store.set('arkode-pocket-dek', 'not json at all');
    expect(await loadPairing('x')).toBeNull();
  });

  it('treats a malformed (wrong-length) dek as "no pairing"', async () => {
    store.set('arkode-pocket-dek', JSON.stringify({ pocketId: 'p1', dek: Buffer.from('short').toString('base64'), driveRemotePath: 'x', driveFileId: null }));
    expect(await loadPairing('x')).toBeNull();
  });

  it('clearPairing removes it entirely', async () => {
    await savePairing({ pocketId: 'p1', dek: SAMPLE_DEK, driveRemotePath: 'Arkode/Pocket', driveFileId: null });
    await clearPairing();
    expect(await hasStoredPairing()).toBe(false);
  });

  describe('looksLikeBiometricInvalidation', () => {
    it('recognizes the common Android/iOS invalidation phrasing', () => {
      expect(looksLikeBiometricInvalidation(new Error('Key permanently invalidated'))).toBe(true);
      expect(looksLikeBiometricInvalidation(new Error('biometry changed'))).toBe(true);
    });
    it('does not flag an unrelated error', () => {
      expect(looksLikeBiometricInvalidation(new Error('Network request failed'))).toBe(false);
    });
  });
});
