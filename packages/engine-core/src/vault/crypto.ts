import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Vault cryptography — the ONLY place that touches primitives.
 *
 *   master password --scrypt(salt)--> KEK (32B)
 *   random DEK (32B) at init, AES-256-GCM-wrapped by the KEK
 *   DEK encrypts every Tier 2 secret blob
 *
 * Only `node:crypto` primitives (`scryptSync`, AES-256-GCM, `randomBytes`).
 * No new runtime dependency, no custom algorithm. Every ciphertext is a
 * self-describing blob so a future format change stays readable:
 *
 *   magic "ARKV" (4) | version (1) | algId (1) | nonce (12) | ciphertext | tag (16)
 */

export const VAULT_FORMAT_VERSION = 1;

const MAGIC = Buffer.from('ARKV', 'ascii');
const ALG_AES_256_GCM = 1;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const HEADER_LEN = MAGIC.length + 2; // magic + version + algId
const MIN_BLOB_LEN = HEADER_LEN + NONCE_LEN + TAG_LEN;

/** A fixed known plaintext, encrypted under the DEK, stored in vault_meta.verifier. */
export const VERIFIER_PLAINTEXT = Buffer.from('arkode-vault-verifier-v1', 'utf8');

export interface ScryptParams {
  /** CPU/memory cost (power of two). */
  N: number;
  r: number;
  p: number;
  keylen: number;
}

// N=2^17, r=8, p=1 ≈ 128 MiB of scratch memory — deliberately heavy for a
// local single-user desktop; stored in vault_meta so it can be raised later
// without breaking existing blobs (only the KEK derivation uses it).
export const DEFAULT_SCRYPT_PARAMS: ScryptParams = { N: 2 ** 17, r: 8, p: 1, keylen: KEY_LEN };

export class VaultCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultCryptoError';
  }
}

export function generateSalt(): Buffer {
  return randomBytes(16);
}

export function generateDek(): Buffer {
  return randomBytes(KEY_LEN);
}

/** Derives the Key Encryption Key from the master password + salt. */
export function deriveKek(password: string, salt: Buffer, params: ScryptParams = DEFAULT_SCRYPT_PARAMS): Buffer {
  // scryptSync's default maxmem (32 MiB) is far below what N=2^17,r=8 needs
  // (~128*N*r bytes); give generous headroom.
  const maxmem = Math.max(256 * 1024 * 1024, 256 * params.N * params.r);
  return scryptSync(Buffer.from(password.normalize('NFKC'), 'utf8'), salt, params.keylen, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem,
  });
}

/** Encrypts bytes under `key`, returning a self-describing blob. */
export function encryptBytes(plaintext: Buffer, key: Buffer): Buffer {
  if (key.length !== KEY_LEN) throw new VaultCryptoError(`key must be ${KEY_LEN} bytes`);
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, Buffer.from([VAULT_FORMAT_VERSION, ALG_AES_256_GCM]), nonce, ciphertext, tag]);
}

/** Decrypts a blob produced by `encryptBytes`. Throws `VaultCryptoError` on a wrong key or any tampering. */
export function decryptBytes(blob: Buffer, key: Buffer): Buffer {
  if (key.length !== KEY_LEN) throw new VaultCryptoError(`key must be ${KEY_LEN} bytes`);
  if (blob.length < MIN_BLOB_LEN) throw new VaultCryptoError('ciphertext blob is truncated or corrupted');
  if (!blob.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new VaultCryptoError('not an arkode vault ciphertext (bad magic)');
  }
  const version = blob[MAGIC.length];
  const alg = blob[MAGIC.length + 1];
  if (version !== VAULT_FORMAT_VERSION) {
    throw new VaultCryptoError(`unsupported vault ciphertext format version ${version} (this build understands ${VAULT_FORMAT_VERSION})`);
  }
  if (alg !== ALG_AES_256_GCM) {
    throw new VaultCryptoError(`unsupported vault ciphertext algorithm ${alg}`);
  }
  const nonce = blob.subarray(HEADER_LEN, HEADER_LEN + NONCE_LEN);
  const tag = blob.subarray(blob.length - TAG_LEN);
  const ciphertext = blob.subarray(HEADER_LEN + NONCE_LEN, blob.length - TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new VaultCryptoError('decryption failed — wrong master password or corrupted ciphertext');
  }
}

export function encryptString(plaintext: string, key: Buffer): Buffer {
  return encryptBytes(Buffer.from(plaintext, 'utf8'), key);
}

export function decryptString(blob: Buffer, key: Buffer): string {
  return decryptBytes(blob, key).toString('utf8');
}

/** Wraps the DEK for storage in vault_meta. */
export function wrapDek(dek: Buffer, kek: Buffer): Buffer {
  return encryptBytes(dek, kek);
}

/** Unwraps the DEK; throws `VaultCryptoError` if the password (→ KEK) is wrong. */
export function unwrapDek(wrapped: Buffer, kek: Buffer): Buffer {
  return decryptBytes(wrapped, kek);
}

/** Builds the verifier blob (VERIFIER_PLAINTEXT under the DEK). */
export function buildVerifier(dek: Buffer): Buffer {
  return encryptBytes(VERIFIER_PLAINTEXT, dek);
}

/** True iff `verifier` decrypts under `dek` to exactly VERIFIER_PLAINTEXT. */
export function verifierMatches(verifier: Buffer, dek: Buffer): boolean {
  try {
    const plain = decryptBytes(verifier, dek);
    return plain.length === VERIFIER_PLAINTEXT.length && timingSafeEqual(plain, VERIFIER_PLAINTEXT);
  } catch {
    return false;
  }
}

/** Best-effort in-place wipe of key material. Not a security guarantee on V8 — copies may persist. */
export function wipe(buf: Buffer | null | undefined): void {
  if (buf && buf.length > 0) buf.fill(0);
}
