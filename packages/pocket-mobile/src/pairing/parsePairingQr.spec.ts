import { buildPairingPayload, serializePairingPayload } from 'pocket-shared';
import { nodePocketCryptoAdapter } from 'pocket-shared/node';
import { generatePocketDek } from 'pocket-shared';
import { parseScannedPairingQr } from './parsePairingQr';

describe('parseScannedPairingQr', () => {
  it('parses a real QR payload (as Desktop would generate it) into a usable pairing + DEK', () => {
    const dek = generatePocketDek(nodePocketCryptoAdapter);
    const payload = buildPairingPayload({ pocketId: 'p1', dek, drive: { fileId: 'f1', remotePath: 'Arkode/Pocket', fileName: 'arkode-pocket-sync.json' } });
    const qrText = serializePairingPayload(payload);

    const scanned = parseScannedPairingQr(qrText);
    expect(scanned.payload.pocketId).toBe('p1');
    expect(Buffer.from(scanned.dek).equals(Buffer.from(dek))).toBe(true);
  });

  it('throws a user-facing message for a QR that is not an Arkode Pocket pairing code', () => {
    expect(() => parseScannedPairingQr('https://example.com/not-a-pairing-code')).toThrow(/not a valid Arkode Pocket pairing code/);
  });
});
