import QuickCrypto from 'react-native-quick-crypto';
import { concatBytes, type PocketCryptoAdapter } from 'pocket-shared';

/**
 * `react-native-quick-crypto`-backed implementation of `PocketCryptoAdapter`
 * — the mobile-side equivalent of `pocket-shared/node`'s
 * `nodePocketCryptoAdapter`, deliberately living HERE (not in pocket-shared,
 * which must stay free of any platform-specific runtime dependency) and
 * NOT in engine-core (which must never depend on a React Native package).
 *
 * Deliberately avoids relying on a global `Buffer` (not guaranteed present
 * under Hermes without an extra polyfill) — works with plain `Uint8Array`
 * throughout, using pocket-shared's own `concatBytes` instead of
 * `Buffer.concat`. `react-native-quick-crypto`'s `update()`/`final()`
 * accept and return Buffer-like values that are Uint8Array-compatible, the
 * same as Node's own `crypto` module.
 *
 * react-native-quick-crypto mirrors Node's `crypto` module API closely
 * enough that this file is nearly identical to the Node adapter — the whole
 * point of sharing pocket-shared's byte-framing logic. It is backed by a
 * native module (JSI + BoringSSL), so it cannot run under plain Jest/Node —
 * see crypto/cryptoInterop.spec.ts, which instead proves format
 * compatibility using pocket-shared's OWN Node adapter on both "sides" of
 * the round-trip. This file's actual correctness can only be verified on a
 * real device.
 */
export const quickCryptoPocketAdapter: PocketCryptoAdapter = {
  randomBytes(length) {
    return new Uint8Array(QuickCrypto.randomBytes(length));
  },
  aesGcmEncrypt(key, nonce, plaintext) {
    const cipher = QuickCrypto.createCipheriv('aes-256-gcm', key, nonce);
    const ciphertext = concatBytes([new Uint8Array(cipher.update(plaintext)), new Uint8Array(cipher.final())]);
    const authTag = new Uint8Array(cipher.getAuthTag());
    return { ciphertext, authTag };
  },
  aesGcmDecrypt(key, nonce, ciphertext, authTag) {
    const decipher = QuickCrypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(authTag);
    return concatBytes([new Uint8Array(decipher.update(ciphertext)), new Uint8Array(decipher.final())]);
  },
};
