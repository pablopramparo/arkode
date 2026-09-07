import {
  buildPocketSyncFile,
  decryptPocketSnapshotPayload,
  parsePocketSyncFile,
  serializePocketSyncFile,
  PocketCryptoError,
} from 'pocket-shared';
import { nodePocketCryptoAdapter } from 'pocket-shared/node';
import { SAMPLE_POCKET_SNAPSHOT, SAMPLE_POCKET_DEK, SAMPLE_POCKET_ID } from 'pocket-shared/fixtures';

/**
 * Proves the mobile side's own crypto call sites (decryptPocketSnapshotPayload
 * / parsePocketSyncFile, called with whichever PocketCryptoAdapter the
 * platform provides) work against a byte-for-byte realistic "Desktop
 * fixture." `quickCryptoPocketAdapter` (react-native-quick-crypto) itself
 * cannot run under plain Jest/Node — no JSI/native module host here — so
 * this uses pocket-shared's own Node adapter for BOTH sides of the round
 * trip. That still proves everything this app's logic actually depends on:
 * pocket-shared's byte format is what's shared, and the adapter is a thin,
 * near-identical wrapper on each platform (see quickCryptoAdapter.ts's own
 * doc comment). Real on-device verification remains the standard for the
 * adapter file itself, same as this repo's own established precedent for
 * anything that needs a real device/server it can't run in CI.
 */
describe('crypto interop against a Desktop-shaped fixture', () => {
  it('opens a snapshot built the same way Desktop builds one', () => {
    const file = buildPocketSyncFile(
      SAMPLE_POCKET_SNAPSHOT,
      SAMPLE_POCKET_DEK,
      { pocketId: SAMPLE_POCKET_ID, revision: 7, generatedAt: '2026-01-01T00:00:00.000Z' },
      nodePocketCryptoAdapter
    );
    const bytes = serializePocketSyncFile(file);
    const reparsed = parsePocketSyncFile(bytes);
    const payload = decryptPocketSnapshotPayload(reparsed, SAMPLE_POCKET_DEK, nodePocketCryptoAdapter);
    expect(payload).toEqual(SAMPLE_POCKET_SNAPSHOT);
  });

  it('rejects the wrong Pocket DEK (e.g. after a revocation on a stale device)', () => {
    const file = buildPocketSyncFile(SAMPLE_POCKET_SNAPSHOT, SAMPLE_POCKET_DEK, { pocketId: SAMPLE_POCKET_ID, revision: 1, generatedAt: 'now' }, nodePocketCryptoAdapter);
    const bytes = serializePocketSyncFile(file);
    const wrongDek = new Uint8Array(32).fill(9);
    expect(() => decryptPocketSnapshotPayload(parsePocketSyncFile(bytes), wrongDek, nodePocketCryptoAdapter)).toThrow(PocketCryptoError);
  });

  it('rejects a tampered payload', () => {
    const file = buildPocketSyncFile(SAMPLE_POCKET_SNAPSHOT, SAMPLE_POCKET_DEK, { pocketId: SAMPLE_POCKET_ID, revision: 1, generatedAt: 'now' }, nodePocketCryptoAdapter);
    const bytes = serializePocketSyncFile(file);
    const tampered = Buffer.from(bytes).toString('utf8').replace('"payload":"', '"payload":"AA');
    expect(() => decryptPocketSnapshotPayload(parsePocketSyncFile(new TextEncoder().encode(tampered)), SAMPLE_POCKET_DEK, nodePocketCryptoAdapter)).toThrow();
  });

  it('rejects an unsupported future format version with a user-facing upgrade message', () => {
    const file = buildPocketSyncFile(SAMPLE_POCKET_SNAPSHOT, SAMPLE_POCKET_DEK, { pocketId: SAMPLE_POCKET_ID, revision: 1, generatedAt: 'now' }, nodePocketCryptoAdapter);
    const raw = JSON.parse(Buffer.from(serializePocketSyncFile(file)).toString('utf8'));
    raw.formatVersion = 999;
    expect(() => parsePocketSyncFile(JSON.stringify(raw))).toThrow(/newer version of Arkode Pocket/);
  });
});
