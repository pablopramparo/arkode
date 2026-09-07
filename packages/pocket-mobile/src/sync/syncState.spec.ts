import { buildPocketSyncFile, serializePocketSyncFile } from 'pocket-shared';
import { nodePocketCryptoAdapter } from 'pocket-shared/node';
import { SAMPLE_POCKET_SNAPSHOT, SAMPLE_POCKET_DEK, SAMPLE_POCKET_ID } from 'pocket-shared/fixtures';
import { decideSnapshotUpdate } from './syncState';

function fileBytes(revision: number, dek = SAMPLE_POCKET_DEK) {
  const file = buildPocketSyncFile(SAMPLE_POCKET_SNAPSHOT, dek, { pocketId: SAMPLE_POCKET_ID, revision, generatedAt: '2026-01-01T00:00:00.000Z' }, nodePocketCryptoAdapter);
  return serializePocketSyncFile(file);
}

describe('decideSnapshotUpdate — the "never lose the last good snapshot" contract', () => {
  it('first download (currentRevision null) always adopts a valid file', () => {
    const decision = decideSnapshotUpdate(null, fileBytes(1), SAMPLE_POCKET_DEK, nodePocketCryptoAdapter);
    expect(decision.kind).toBe('adopt');
    if (decision.kind === 'adopt') {
      expect(decision.file.revision).toBe(1);
      expect(decision.payload).toEqual(SAMPLE_POCKET_SNAPSHOT);
    }
  });

  it('a strictly newer revision is adopted', () => {
    const decision = decideSnapshotUpdate(5, fileBytes(6), SAMPLE_POCKET_DEK, nodePocketCryptoAdapter);
    expect(decision.kind).toBe('adopt');
  });

  it('the SAME revision is a safe no-op, not an unnecessary replace', () => {
    const decision = decideSnapshotUpdate(5, fileBytes(5), SAMPLE_POCKET_DEK, nodePocketCryptoAdapter);
    expect(decision).toEqual({ kind: 'no_change', reason: 'same_revision' });
  });

  it('an OLDER remote revision than what we already trust is ignored safely', () => {
    const decision = decideSnapshotUpdate(5, fileBytes(3), SAMPLE_POCKET_DEK, nodePocketCryptoAdapter);
    expect(decision).toEqual({ kind: 'no_change', reason: 'older_revision' });
  });

  it('a corrupt remote file is rejected, never adopted', () => {
    const decision = decideSnapshotUpdate(1, new TextEncoder().encode('not a pocket sync file'), SAMPLE_POCKET_DEK, nodePocketCryptoAdapter);
    expect(decision.kind).toBe('reject');
    if (decision.kind === 'reject') expect(decision.reason).toBe('corrupt');
  });

  it('a decrypt failure (wrong/rotated key) is rejected, distinguishable from plain corruption', () => {
    const wrongDek = new Uint8Array(32).fill(7);
    const decision = decideSnapshotUpdate(null, fileBytes(1), wrongDek, nodePocketCryptoAdapter);
    expect(decision.kind).toBe('reject');
    if (decision.kind === 'reject') expect(decision.reason).toBe('decrypt_failed');
  });

  it('an unsupported future format version is rejected with the upgrade reason, checked before decryption', () => {
    const file = buildPocketSyncFile(SAMPLE_POCKET_SNAPSHOT, SAMPLE_POCKET_DEK, { pocketId: SAMPLE_POCKET_ID, revision: 1, generatedAt: 'now' }, nodePocketCryptoAdapter);
    const bytes = serializePocketSyncFile(file);
    const raw = JSON.parse(Buffer.from(bytes).toString('utf8'));
    raw.formatVersion = 999;
    const wrongDek = new Uint8Array(32).fill(1); // even a right/wrong key must not matter — this fails on the outer envelope
    const decision = decideSnapshotUpdate(null, new TextEncoder().encode(JSON.stringify(raw)), wrongDek, nodePocketCryptoAdapter);
    expect(decision).toEqual({ kind: 'reject', reason: 'unsupported_format', message: expect.stringContaining('newer version of Arkode Pocket') });
  });
});
