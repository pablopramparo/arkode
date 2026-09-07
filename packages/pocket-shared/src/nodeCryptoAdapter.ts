import { createCipheriv, createDecipheriv, randomBytes as nodeRandomBytes } from 'node:crypto';
import type { PocketCryptoAdapter } from './crypto.js';

/**
 * `node:crypto`-backed implementation of `PocketCryptoAdapter`, for Desktop
 * (`engine-core`) only. Imported from the `pocket-shared/node` subpath so a
 * React Native bundler never has to resolve (or fail to resolve) `node:crypto`
 * just from importing the package's pure default entry point.
 */
export const nodePocketCryptoAdapter: PocketCryptoAdapter = {
  randomBytes(length) {
    return new Uint8Array(nodeRandomBytes(length));
  },
  aesGcmEncrypt(key, nonce, plaintext) {
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    const ciphertext = new Uint8Array(Buffer.concat([cipher.update(plaintext), cipher.final()]));
    const authTag = new Uint8Array(cipher.getAuthTag());
    return { ciphertext, authTag };
  },
  aesGcmDecrypt(key, nonce, ciphertext, authTag) {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(authTag);
    return new Uint8Array(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
  },
};
