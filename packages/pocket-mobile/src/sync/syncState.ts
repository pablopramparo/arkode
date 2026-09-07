import {
  decryptPocketSnapshotPayload,
  parsePocketSyncFile,
  PocketCryptoError,
  PocketFormatError,
  type PocketCryptoAdapter,
  type PocketSnapshotPayload,
  type PocketSyncFile,
} from 'pocket-shared';

/**
 * The one hard rule this whole module exists to enforce: a failed or
 * ambiguous update NEVER replaces the last good cached snapshot. Every
 * branch below either returns `adopt` (caller may now persist + use the new
 * bytes) or a non-adopt result (caller must leave the existing cache
 * completely untouched). There is no other way out of this function.
 */
export type SnapshotUpdateDecision =
  | { kind: 'adopt'; file: PocketSyncFile; payload: PocketSnapshotPayload }
  | { kind: 'no_change'; reason: 'same_revision' | 'older_revision' }
  | { kind: 'reject'; reason: 'corrupt' | 'decrypt_failed' | 'unsupported_format'; message: string };

/**
 * Given the revision currently trusted locally (or null if this is the
 * first-ever download) and the raw bytes just fetched from Drive, decides
 * whether to adopt them. Never throws — every failure mode pocket-shared's
 * parser/decryptor can produce is caught and turned into a `reject`.
 *
 * Revision comparison uses ONLY the header's `revision` integer (never a
 * timestamp — see docs/pocket.md) and happens BEFORE decryption, so a
 * same/older revision is recognized cheaply without needing the DEK at all.
 */
export function decideSnapshotUpdate(
  currentRevision: number | null,
  candidateBytes: Uint8Array,
  dek: Uint8Array,
  adapter: PocketCryptoAdapter
): SnapshotUpdateDecision {
  let file: PocketSyncFile;
  try {
    file = parsePocketSyncFile(candidateBytes);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const unsupported = err instanceof PocketFormatError && /newer version of Arkode Pocket/.test(message);
    return { kind: 'reject', reason: unsupported ? 'unsupported_format' : 'corrupt', message };
  }

  if (currentRevision != null) {
    if (file.revision === currentRevision) return { kind: 'no_change', reason: 'same_revision' };
    if (file.revision < currentRevision) return { kind: 'no_change', reason: 'older_revision' };
  }

  let payload: PocketSnapshotPayload;
  try {
    payload = decryptPocketSnapshotPayload(file, dek, adapter);
  } catch (err) {
    // Distinguish "wrong/rotated key" from "well-formed JSON but garbage
    // shape" only insofar as pocket-shared itself already does — both are
    // non-adopt, but the caller uses this to suggest "maybe re-pair" only
    // for the crypto failure, not for a plain corrupt-JSON case.
    const reason = err instanceof PocketCryptoError ? 'decrypt_failed' : 'corrupt';
    return { kind: 'reject', reason, message: err instanceof Error ? err.message : String(err) };
  }

  return { kind: 'adopt', file, payload };
}
