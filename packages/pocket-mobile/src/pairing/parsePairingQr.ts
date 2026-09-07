import { pairingPayloadDek, parsePairingPayload, type PocketPairingPayload } from 'pocket-shared';

export interface ScannedPairing {
  payload: PocketPairingPayload;
  dek: Uint8Array;
}

/**
 * The QR's raw text IS the JSON pairing payload (see pocket-shared/pairing.ts)
 * — no extra encoding on top. Thin wrapper so the scanner screen has one
 * call that either returns a validated pairing or throws a message safe to
 * show the user directly (PocketFormatError's messages are already
 * user-facing, never a raw stack trace).
 */
export function parseScannedPairingQr(rawText: string): ScannedPairing {
  const payload = parsePairingPayload(rawText);
  return { payload, dek: pairingPayloadDek(payload) };
}
