import * as Keychain from 'react-native-keychain';
import { base64ToBytes, bytesToBase64 } from 'pocket-shared';

/**
 * Where the Pocket DEK (and its pairing metadata) lives on the phone:
 * Android Keystore / iOS Keychain, gated by biometry, via
 * `react-native-keychain` (a thin, mature wrapper over the real OS APIs —
 * not a home-grown "secure storage").
 *
 * Deliberate choices, all load-bearing for the threat model documented in
 * docs/pocket.md:
 *  - `ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY` — the `THIS_DEVICE_ONLY`
 *    suffix is what stops iOS from silently propagating this item to the
 *    user's other Apple devices via iCloud Keychain sync. Without it, a
 *    user with iCloud Keychain enabled could end up with Pocket "paired" on
 *    a second phone that never went through an explicit pairing QR.
 *  - `ACCESS_CONTROL.BIOMETRY_CURRENT_SET_OR_DEVICE_PASSCODE` — gates every
 *    read behind biometry (falling back to the device passcode/PIN if
 *    biometrics are unavailable, so a user who disabled Face/Touch ID isn't
 *    locked out). `BIOMETRY_CURRENT_SET` (not `BIOMETRY_ANY`) means the
 *    item is INVALIDATED if the enrolled biometrics change (a new
 *    fingerprint/face added) — see requireReEnrollIfInvalidated below for
 *    why that's the correct behavior, not a bug to work around.
 *  - No `securityLevel` is forced: StrongBox/Secure-Enclave-backed storage
 *    is used opportunistically when the device offers it, but this app
 *    never demands hardware-only storage, which could otherwise fail
 *    pairing outright on a cheaper device with no dedicated secure element.
 */
const SERVICE = 'arkode-pocket-dek';

export interface StoredPairing {
  pocketId: string;
  /** 32 raw bytes. */
  dek: Uint8Array;
  driveRemotePath: string;
  driveFileId: string | null;
}

interface StoredPairingJson {
  pocketId: string;
  dek: string; // base64
  driveRemotePath: string;
  driveFileId: string | null;
}

/** True iff SOME pairing is stored — does not itself trigger a biometric prompt. */
export async function hasStoredPairing(): Promise<boolean> {
  const exists = await Keychain.hasGenericPassword({ service: SERVICE });
  return exists;
}

export async function savePairing(pairing: StoredPairing): Promise<void> {
  const json: StoredPairingJson = {
    pocketId: pairing.pocketId,
    dek: bytesToBase64(pairing.dek),
    driveRemotePath: pairing.driveRemotePath,
    driveFileId: pairing.driveFileId,
  };
  const result = await Keychain.setGenericPassword('arkode-pocket', JSON.stringify(json), {
    service: SERVICE,
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    accessControl: Keychain.ACCESS_CONTROL.BIOMETRY_CURRENT_SET_OR_DEVICE_PASSCODE,
  });
  if (!result) throw new Error('No se pudo guardar la clave de Arkode Pocket en el almacenamiento seguro del dispositivo.');
}

/**
 * Reads the pairing, prompting biometry/passcode. Returns null if nothing
 * is stored, OR if the stored item is corrupted/unparsable (treated the
 * same as "no pairing" — the caller sends the user back to the pairing
 * screen rather than crashing on a malformed blob).
 *
 * Throws only if the user cancels or the platform auth prompt itself fails
 * — the caller distinguishes "no pairing" from "auth failed" by catching
 * this separately from a null return.
 */
export async function loadPairing(promptMessage: string): Promise<StoredPairing | null> {
  const creds = await Keychain.getGenericPassword({
    service: SERVICE,
    authenticationPrompt: { title: promptMessage },
  });
  if (!creds) return null;
  try {
    const parsed = JSON.parse(creds.password) as StoredPairingJson;
    const dek = base64ToBytes(parsed.dek);
    if (dek.length !== 32) return null;
    return { pocketId: parsed.pocketId, dek, driveRemotePath: parsed.driveRemotePath, driveFileId: parsed.driveFileId };
  } catch {
    return null;
  }
}

export async function clearPairing(): Promise<void> {
  await Keychain.resetGenericPassword({ service: SERVICE });
}

/**
 * `react-native-keychain` surfaces a Keystore/Keychain "item invalidated"
 * failure as a normal getGenericPassword() rejection (message varies by
 * platform), not a typed error — this is a best-effort heuristic match, not
 * an exhaustive parser. On a false negative the user just sees a generic
 * auth failure and can retry; on a false positive they're told to re-pair
 * when a retry might have worked — both are acceptable, non-destructive
 * outcomes (never silently succeeds with a wrong key either way, since the
 * decrypt step afterwards would fail regardless).
 */
export function looksLikeBiometricInvalidation(err: unknown): boolean {
  const message = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  return (
    message.includes('key permanently invalidated') || // Android KeyStore
    message.includes('invalidated') ||
    message.includes('biometrykeys') ||
    (message.includes('biometry') && message.includes('changed'))
  );
}
