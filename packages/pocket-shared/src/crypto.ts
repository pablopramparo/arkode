import { bytesEqual, concatBytes, utf8ToBytes } from './bytes.js';

/**
 * Pocket cryptography — the ONLY place in this package that defines the
 * ciphertext byte layout. Deliberately independent of the Desktop vault's
 * own crypto (`engine-core/src/vault/crypto.ts`): there is no master
 * password, no KEK, no scrypt, and no verifier blob here. The Pocket DEK is
 * a random, device-provisioned symmetric key handed to a phone during
 * pairing — it is either the right key (decryption succeeds) or it isn't
 * (AES-GCM's own auth tag rejects it), so a separate password-verification
 * dance has nothing to add.
 *
 *   random Pocket DEK (32B) --AES-256-GCM--> encrypts the whole snapshot payload
 *
 * Self-describing blob, independent of whatever outer JSON envelope wraps
 * it (see format.ts):
 *
 *   magic "ARKB" (4) | version (1) | algId (1) | nonce (12) | ciphertext | tag (16)
 *
 * No separate SHA-256/checksum field anywhere in this package: AES-256-GCM's
 * 128-bit authentication tag already detects any bit flip or truncation in
 * the ciphertext with cryptographic strength — a bolted-on hash would only
 * ever agree with what the tag already tells you, so it isn't added.
 */

export const POCKET_BLOB_FORMAT_VERSION = 1;

const MAGIC = utf8ToBytes('ARKB');
const ALG_AES_256_GCM = 1;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const HEADER_LEN = MAGIC.length + 2; // magic + version + algId
const MIN_BLOB_LEN = HEADER_LEN + NONCE_LEN + TAG_LEN;

export class PocketCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PocketCryptoError';
  }
}

/**
 * The one seam every platform must implement. Desktop provides a
 * `node:crypto`-backed adapter (see `./nodeCryptoAdapter.js`); the mobile
 * app provides its own (e.g. backed by `react-native-quick-crypto`) that
 * lives in `packages/pocket-mobile`, never in this package — pocket-shared
 * itself must stay free of any platform-specific runtime dependency.
 */
export interface PocketCryptoAdapter {
  randomBytes(length: number): Uint8Array;
  aesGcmEncrypt(
    key: Uint8Array,
    nonce: Uint8Array,
    plaintext: Uint8Array
  ): { ciphertext: Uint8Array; authTag: Uint8Array };
  /** Must throw on an authentication-tag mismatch (wrong key or tampered ciphertext). */
  aesGcmDecrypt(key: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array, authTag: Uint8Array): Uint8Array;
}

export function generatePocketDek(adapter: Pick<PocketCryptoAdapter, 'randomBytes'>): Uint8Array {
  return adapter.randomBytes(KEY_LEN);
}

export function encryptPocketBlob(plaintext: Uint8Array, key: Uint8Array, adapter: PocketCryptoAdapter): Uint8Array {
  if (key.length !== KEY_LEN) throw new PocketCryptoError(`Pocket key must be ${KEY_LEN} bytes`);
  const nonce = adapter.randomBytes(NONCE_LEN);
  const { ciphertext, authTag } = adapter.aesGcmEncrypt(key, nonce, plaintext);
  if (authTag.length !== TAG_LEN) throw new PocketCryptoError(`unexpected auth tag length ${authTag.length}`);
  return concatBytes([MAGIC, Uint8Array.of(POCKET_BLOB_FORMAT_VERSION, ALG_AES_256_GCM), nonce, ciphertext, authTag]);
}

export function decryptPocketBlob(blob: Uint8Array, key: Uint8Array, adapter: PocketCryptoAdapter): Uint8Array {
  if (key.length !== KEY_LEN) throw new PocketCryptoError(`Pocket key must be ${KEY_LEN} bytes`);
  if (blob.length < MIN_BLOB_LEN) throw new PocketCryptoError('Pocket ciphertext blob is truncated or corrupted');
  if (!bytesEqual(blob.subarray(0, MAGIC.length), MAGIC)) {
    throw new PocketCryptoError('not an arkode pocket ciphertext (bad magic)');
  }
  const version = blob[MAGIC.length];
  const alg = blob[MAGIC.length + 1];
  if (version !== POCKET_BLOB_FORMAT_VERSION) {
    throw new PocketCryptoError(`unsupported pocket ciphertext version ${version} (this build understands ${POCKET_BLOB_FORMAT_VERSION})`);
  }
  if (alg !== ALG_AES_256_GCM) {
    throw new PocketCryptoError(`unsupported pocket ciphertext algorithm ${alg}`);
  }
  const nonce = blob.subarray(HEADER_LEN, HEADER_LEN + NONCE_LEN);
  const authTag = blob.subarray(blob.length - TAG_LEN);
  const ciphertext = blob.subarray(HEADER_LEN + NONCE_LEN, blob.length - TAG_LEN);
  try {
    return adapter.aesGcmDecrypt(key, nonce, ciphertext, authTag);
  } catch {
    throw new PocketCryptoError('decryption failed — wrong Pocket key or corrupted ciphertext');
  }
}

/** Best-effort in-place wipe of key material. Not a guarantee on a GC'd runtime — copies may persist. */
export function wipe(buf: Uint8Array | null | undefined): void {
  if (buf && buf.length > 0) buf.fill(0);
}
