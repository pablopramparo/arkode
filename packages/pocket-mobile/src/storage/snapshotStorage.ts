import * as FileSystem from 'expo-file-system';
import { base64ToBytes, bytesToBase64 } from 'pocket-shared';

/**
 * Persists ONLY the still-encrypted `arkode-pocket-sync` file bytes — never
 * the decrypted JSON, never a password/token in isolation. Even so, this
 * deliberately uses `cacheDirectory`, not `documentDirectory`:
 *  - `cacheDirectory` is excluded from iOS's iCloud/iTunes device backup and
 *    from Android's Auto Backup by definition (see docs/pocket.md's OS
 *    backup section) — belt-and-suspenders on top of `allowBackup=false` in
 *    app.json, even though the file is harmless ciphertext without the
 *    Keychain/Keystore-held Pocket DEK.
 *  - Treating it as a cache is also the HONEST framing: if the OS clears it
 *    under storage pressure, the worst case is a re-download from Drive on
 *    next connectivity — never data loss, since Desktop remains the one
 *    source of truth. This is not the "last good snapshot" the app must
 *    protect at all costs; it's a disposable local copy of something that
 *    can always be re-fetched.
 */
const DIR = `${FileSystem.cacheDirectory}arkode-pocket/`;
const FILE = `${DIR}snapshot.bin`;
const TMP_FILE = `${FILE}.tmp`;

export async function loadCachedSnapshotFile(): Promise<Uint8Array | null> {
  const info = await FileSystem.getInfoAsync(FILE);
  if (!info.exists) return null;
  const b64 = await FileSystem.readAsStringAsync(FILE, { encoding: FileSystem.EncodingType.Base64 });
  return base64ToBytes(b64);
}

/**
 * Atomic replace: write to a temp file, then move it over the real one.
 * Mirrors the same tmp-then-rename discipline Desktop's own publish path
 * uses — a crash or app-kill mid-write can never leave a half-written file
 * masquerading as the current cache.
 */
export async function saveCachedSnapshotFileAtomically(bytes: Uint8Array): Promise<void> {
  await FileSystem.makeDirectoryAsync(DIR, { intermediates: true }).catch(() => {});
  await FileSystem.writeAsStringAsync(TMP_FILE, bytesToBase64(bytes), { encoding: FileSystem.EncodingType.Base64 });
  await FileSystem.deleteAsync(FILE, { idempotent: true });
  await FileSystem.moveAsync({ from: TMP_FILE, to: FILE });
}

export async function clearCachedSnapshotFile(): Promise<void> {
  await FileSystem.deleteAsync(FILE, { idempotent: true });
  await FileSystem.deleteAsync(TMP_FILE, { idempotent: true });
}
