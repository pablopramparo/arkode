/**
 * `expo-file-system` mocked with a plain in-memory Map — proves this file's
 * OWN contract (atomic tmp-then-move replace, base64 round-trip, "no cache
 * yet" returns null rather than throwing) without a real device filesystem.
 */
const fakeFs = new Map<string, string>();

jest.mock('expo-file-system', () => ({
  cacheDirectory: 'file:///cache/',
  EncodingType: { Base64: 'base64' },
  getInfoAsync: jest.fn(async (path: string) => ({ exists: fakeFs.has(path) })),
  makeDirectoryAsync: jest.fn(async () => undefined),
  readAsStringAsync: jest.fn(async (path: string) => {
    const v = fakeFs.get(path);
    if (v === undefined) throw new Error(`ENOENT: ${path}`);
    return v;
  }),
  writeAsStringAsync: jest.fn(async (path: string, content: string) => {
    fakeFs.set(path, content);
  }),
  deleteAsync: jest.fn(async (path: string) => {
    fakeFs.delete(path);
  }),
  moveAsync: jest.fn(async ({ from, to }: { from: string; to: string }) => {
    const v = fakeFs.get(from);
    if (v === undefined) throw new Error(`ENOENT: ${from}`);
    fakeFs.set(to, v);
    fakeFs.delete(from);
  }),
}));

import { loadCachedSnapshotFile, saveCachedSnapshotFileAtomically, clearCachedSnapshotFile } from './snapshotStorage';

beforeEach(() => fakeFs.clear());

describe('snapshotStorage', () => {
  it('returns null when nothing has been cached yet', async () => {
    expect(await loadCachedSnapshotFile()).toBeNull();
  });

  it('round-trips bytes exactly', async () => {
    const bytes = new Uint8Array([1, 2, 3, 250, 0, 255]);
    await saveCachedSnapshotFileAtomically(bytes);
    const loaded = await loadCachedSnapshotFile();
    expect(Array.from(loaded!)).toEqual(Array.from(bytes));
  });

  it('a second save replaces the first (atomically — no temp file left behind)', async () => {
    await saveCachedSnapshotFileAtomically(new Uint8Array([1]));
    await saveCachedSnapshotFileAtomically(new Uint8Array([2, 2]));
    const loaded = await loadCachedSnapshotFile();
    expect(Array.from(loaded!)).toEqual([2, 2]);
    const leftoverTmp = Array.from(fakeFs.keys()).filter((k) => k.endsWith('.tmp'));
    expect(leftoverTmp).toHaveLength(0);
  });

  it('clearCachedSnapshotFile removes it, back to "no cache"', async () => {
    await saveCachedSnapshotFileAtomically(new Uint8Array([1]));
    await clearCachedSnapshotFile();
    expect(await loadCachedSnapshotFile()).toBeNull();
  });
});
