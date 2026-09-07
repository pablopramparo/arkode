import { describe, expect, it } from 'vitest';
import { nodePocketCryptoAdapter } from '../src/nodeCryptoAdapter.js';
import { generatePocketDek } from '../src/crypto.js';
import {
  buildPairingPayload,
  pairingPayloadDek,
  parsePairingPayload,
  serializePairingPayload,
  POCKET_PAIRING_PAYLOAD_VERSION,
} from '../src/pairing.js';

const adapter = nodePocketCryptoAdapter;

describe('pairing QR payload', () => {
  it('round-trips through JSON exactly as it would through a QR code', () => {
    const dek = generatePocketDek(adapter);
    const payload = buildPairingPayload({
      pocketId: 'pocket-123',
      dek,
      drive: { fileId: 'drive-file-id', remotePath: 'Arkode/Pocket', fileName: 'arkode-pocket-sync.json' },
    });
    const qrText = serializePairingPayload(payload);
    const reparsed = parsePairingPayload(qrText);
    expect(reparsed.pocketId).toBe('pocket-123');
    expect(reparsed.v).toBe(POCKET_PAIRING_PAYLOAD_VERSION);
    expect(Buffer.from(pairingPayloadDek(reparsed)).equals(Buffer.from(dek))).toBe(true);
  });

  it('never carries a master-password/vault field or an OAuth token', () => {
    const dek = generatePocketDek(adapter);
    const payload = buildPairingPayload({
      pocketId: 'pocket-123',
      dek,
      drive: { fileId: null, remotePath: 'Arkode/Pocket', fileName: 'arkode-pocket-sync.json' },
    });
    const json = serializePairingPayload(payload);
    for (const forbidden of ['masterPassword', 'kek', 'vaultDek', 'wrappedDek', 'oauth', 'rclone', 'accessToken', 'refreshToken']) {
      expect(json.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it('rejects a Pocket key of the wrong length', () => {
    expect(() =>
      buildPairingPayload({
        pocketId: 'p',
        dek: new Uint8Array(16),
        drive: { fileId: null, remotePath: 'x', fileName: 'y' },
      })
    ).toThrow(/32 bytes/);
  });

  it('rejects garbage QR text', () => {
    expect(() => parsePairingPayload('not a pairing code')).toThrow(/not a valid Arkode Pocket pairing code/);
  });

  it('rejects an unsupported pairing version', () => {
    expect(() => parsePairingPayload(JSON.stringify({ v: 999, pocketId: 'p', dek: 'x', drive: { remotePath: 'a', fileName: 'b' } }))).toThrow(
      /Unsupported pairing code version/
    );
  });

  it('rejects a malformed (wrong-length) dek even if the JSON shape is otherwise valid', () => {
    const bad = JSON.stringify({
      v: 1,
      pocketId: 'p',
      dek: Buffer.from('too-short').toString('base64'),
      drive: { remotePath: 'a', fileName: 'b' },
    });
    expect(() => parsePairingPayload(bad)).toThrow(/malformed Pocket key/);
  });
});
