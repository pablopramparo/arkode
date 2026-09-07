import { base64ToBytes, bytesToBase64 } from './bytes.js';
import { PocketFormatError } from './format.js';

/**
 * The QR pairing payload — the ONLY channel that ever moves the Pocket DEK
 * off the Desktop machine. Deliberately minimal: no master password, no
 * Vault DEK/KEK, no Desktop OAuth/rclone token, nothing beyond what a phone
 * needs to find and decrypt exactly one file.
 *
 * v1 is single-device: the QR carries the raw DEK directly (no asymmetric
 * handshake) because there is no return channel to negotiate one, and a
 * physically-presented, short-lived QR is an accepted transport for this —
 * the same trust model WhatsApp Web / Signal's "link a device" QR use.
 * Whoever scans this QR gets full read access to every Pocket snapshot
 * published from now on, until the device is revoked.
 */
export const POCKET_PAIRING_PAYLOAD_VERSION = 1;
const POCKET_DEK_LENGTH = 32;

export interface PocketPairingDriveHint {
  /** Google Drive file ID of the current arkode-pocket-sync file, if already published once. */
  fileId: string | null;
  /** Folder path Desktop publishes to, e.g. "Arkode/Pocket" — used only if fileId is unavailable yet. */
  remotePath: string;
  fileName: string;
}

export interface PocketPairingPayload {
  v: typeof POCKET_PAIRING_PAYLOAD_VERSION;
  pocketId: string;
  /** base64, exactly 32 bytes. */
  dek: string;
  drive: PocketPairingDriveHint;
}

export function buildPairingPayload(params: {
  pocketId: string;
  dek: Uint8Array;
  drive: PocketPairingDriveHint;
}): PocketPairingPayload {
  if (params.dek.length !== POCKET_DEK_LENGTH) {
    throw new PocketFormatError(`Pocket DEK must be ${POCKET_DEK_LENGTH} bytes.`);
  }
  return {
    v: POCKET_PAIRING_PAYLOAD_VERSION,
    pocketId: params.pocketId,
    dek: bytesToBase64(params.dek),
    drive: params.drive,
  };
}

/** The exact text encoded into (and scanned out of) the QR code. */
export function serializePairingPayload(payload: PocketPairingPayload): string {
  return JSON.stringify(payload);
}

export function parsePairingPayload(text: string): PocketPairingPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new PocketFormatError('This QR code is not a valid Arkode Pocket pairing code.');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new PocketFormatError('This QR code is not a valid Arkode Pocket pairing code.');
  }
  const p = parsed as Record<string, unknown>;
  if (p.v !== POCKET_PAIRING_PAYLOAD_VERSION) {
    throw new PocketFormatError(`Unsupported pairing code version ${String(p.v)}.`);
  }
  if (typeof p.pocketId !== 'string' || typeof p.dek !== 'string' || typeof p.drive !== 'object' || p.drive === null) {
    throw new PocketFormatError('This QR code is missing required pairing fields.');
  }
  const drive = p.drive as Record<string, unknown>;
  if (typeof drive.remotePath !== 'string' || typeof drive.fileName !== 'string') {
    throw new PocketFormatError('This QR code is missing Drive location fields.');
  }
  const dekBytes = base64ToBytes(p.dek);
  if (dekBytes.length !== POCKET_DEK_LENGTH) {
    throw new PocketFormatError('This QR code has a malformed Pocket key.');
  }
  return {
    v: POCKET_PAIRING_PAYLOAD_VERSION,
    pocketId: p.pocketId,
    dek: p.dek,
    drive: {
      fileId: typeof drive.fileId === 'string' ? drive.fileId : null,
      remotePath: drive.remotePath,
      fileName: drive.fileName,
    },
  };
}

/** Convenience: pull the raw 32-byte DEK out of an already-validated payload. */
export function pairingPayloadDek(payload: PocketPairingPayload): Uint8Array {
  return base64ToBytes(payload.dek);
}
