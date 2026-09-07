import { buildPocketSyncFile, serializePocketSyncFile } from 'pocket-shared';
import { nodePocketCryptoAdapter } from 'pocket-shared/node';
import { SAMPLE_POCKET_SNAPSHOT, SAMPLE_POCKET_DEK, SAMPLE_POCKET_ID, SAMPLE_DRIVE_REMOTE_PATH } from 'pocket-shared/fixtures';
import { refreshSnapshot, type RefreshSnapshotDeps } from './refreshSnapshot';

function fileBytes(revision: number) {
  const file = buildPocketSyncFile(SAMPLE_POCKET_SNAPSHOT, SAMPLE_POCKET_DEK, { pocketId: SAMPLE_POCKET_ID, revision, generatedAt: '2026-01-01T00:00:00.000Z' }, nodePocketCryptoAdapter);
  return serializePocketSyncFile(file);
}

const pairing = { dek: SAMPLE_POCKET_DEK, driveFileId: 'file-1', fileName: 'arkode-pocket-sync.json' };

function baseDeps(overrides: Partial<RefreshSnapshotDeps> = {}): RefreshSnapshotDeps {
  return {
    getAccessToken: async () => 'fake-token',
    resolveFileId: async () => 'file-1',
    downloadFile: async () => fileBytes(2),
    cryptoAdapter: nodePocketCryptoAdapter,
    ...overrides,
  };
}

describe('refreshSnapshot — every offline/failure state the home screen banner needs', () => {
  it('a real newer revision updates and returns the decrypted payload + raw bytes to persist', async () => {
    const result = await refreshSnapshot(baseDeps(), pairing, 1);
    expect(result.outcome).toEqual({ kind: 'updated', revision: 2 });
    expect(result.decision?.kind).toBe('adopt');
    expect(result.bytes).toBeDefined();
  });

  it('the same revision remote is up_to_date — no bytes returned to persist (no unnecessary replace)', async () => {
    const result = await refreshSnapshot(baseDeps({ downloadFile: async () => fileBytes(5) }), pairing, 5);
    expect(result.outcome).toEqual({ kind: 'up_to_date' });
    expect(result.bytes).toBeUndefined();
  });

  it('OAuth/sign-in failure never reaches the network step, and is reported distinctly', async () => {
    const download = jest.fn();
    const result = await refreshSnapshot(
      baseDeps({
        getAccessToken: async () => {
          throw new Error('User cancelled Google sign-in');
        },
        downloadFile: download,
      }),
      pairing,
      1
    );
    expect(result.outcome.kind).toBe('oauth_error');
    expect(download).not.toHaveBeenCalled();
  });

  it('a network failure while downloading is reported as network_error, keeping whatever the caller already has', async () => {
    const result = await refreshSnapshot(
      baseDeps({
        downloadFile: async () => {
          throw new Error('Network request failed');
        },
      }),
      pairing,
      1
    );
    expect(result.outcome).toEqual({ kind: 'network_error', message: 'Network request failed' });
  });

  it('a corrupt download surfaces as corrupt, not a crash', async () => {
    const result = await refreshSnapshot(baseDeps({ downloadFile: async () => new TextEncoder().encode('garbage') }), pairing, 1);
    expect(result.outcome.kind).toBe('corrupt');
  });

  it('a decrypt failure (rotated/revoked key) surfaces as decrypt_failed', async () => {
    const result = await refreshSnapshot(baseDeps(), { ...pairing, dek: new Uint8Array(32).fill(3) }, 1);
    expect(result.outcome.kind).toBe('decrypt_failed');
  });

  it('resolveFileId failure (e.g. file not found yet) is a network_error, not a crash', async () => {
    const result = await refreshSnapshot(
      baseDeps({
        resolveFileId: async () => {
          throw new Error('No se encontró el archivo de Arkode Pocket en Google Drive.');
        },
      }),
      pairing,
      1
    );
    expect(result.outcome.kind).toBe('network_error');
  });
});
