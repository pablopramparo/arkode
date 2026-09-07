import { describe, expect, it } from 'vitest';
import { nodePocketCryptoAdapter } from '../src/nodeCryptoAdapter.js';
import { decryptPocketBlob, encryptPocketBlob, generatePocketDek, PocketCryptoError } from '../src/crypto.js';
import { utf8ToBytes, bytesToUtf8 } from '../src/bytes.js';

const adapter = nodePocketCryptoAdapter;

describe('pocket crypto (real AES-256-GCM via node:crypto)', () => {
  it('round-trips plaintext', () => {
    const dek = generatePocketDek(adapter);
    const plaintext = utf8ToBytes(JSON.stringify({ hello: 'pocket' }));
    const blob = encryptPocketBlob(plaintext, dek, adapter);
    const decrypted = decryptPocketBlob(blob, dek, adapter);
    expect(bytesToUtf8(decrypted)).toBe(JSON.stringify({ hello: 'pocket' }));
  });

  it('rejects the wrong key', () => {
    const dek = generatePocketDek(adapter);
    const wrongDek = generatePocketDek(adapter);
    const blob = encryptPocketBlob(utf8ToBytes('secret'), dek, adapter);
    expect(() => decryptPocketBlob(blob, wrongDek, adapter)).toThrow(PocketCryptoError);
  });

  it('rejects a tampered ciphertext byte', () => {
    const dek = generatePocketDek(adapter);
    const blob = encryptPocketBlob(utf8ToBytes('secret payload'), dek, adapter);
    const tampered = new Uint8Array(blob);
    tampered[tampered.length - 20] ^= 0xff; // flip a byte inside the ciphertext region
    expect(() => decryptPocketBlob(tampered, dek, adapter)).toThrow(PocketCryptoError);
  });

  it('rejects a truncated blob', () => {
    const dek = generatePocketDek(adapter);
    const blob = encryptPocketBlob(utf8ToBytes('secret payload'), dek, adapter);
    expect(() => decryptPocketBlob(blob.subarray(0, 5), dek, adapter)).toThrow(/truncated|corrupted/);
  });

  it('rejects a bad magic', () => {
    const dek = generatePocketDek(adapter);
    const blob = encryptPocketBlob(utf8ToBytes('x'), dek, adapter);
    const corrupted = new Uint8Array(blob);
    corrupted[0] ^= 0xff;
    expect(() => decryptPocketBlob(corrupted, dek, adapter)).toThrow(/bad magic/);
  });

  it('rejects an unsupported format version', () => {
    const dek = generatePocketDek(adapter);
    const blob = encryptPocketBlob(utf8ToBytes('x'), dek, adapter);
    const corrupted = new Uint8Array(blob);
    corrupted[4] = 99; // version byte
    expect(() => decryptPocketBlob(corrupted, dek, adapter)).toThrow(/unsupported pocket ciphertext version/);
  });

  it('never reuses a nonce across two encryptions of the same plaintext', () => {
    const dek = generatePocketDek(adapter);
    const plaintext = utf8ToBytes('same plaintext every time');
    const blobA = encryptPocketBlob(plaintext, dek, adapter);
    const blobB = encryptPocketBlob(plaintext, dek, adapter);
    // nonce lives right after the 6-byte header, 12 bytes long
    const nonceA = blobA.subarray(6, 18);
    const nonceB = blobB.subarray(6, 18);
    expect(Buffer.from(nonceA).equals(Buffer.from(nonceB))).toBe(false);
    // and therefore ciphertext differs too, despite identical plaintext + key
    expect(Buffer.from(blobA).equals(Buffer.from(blobB))).toBe(false);
  });

  it('generatePocketDek returns 32 bytes', () => {
    expect(generatePocketDek(adapter).length).toBe(32);
  });

  it('rejects a key of the wrong length', () => {
    expect(() => encryptPocketBlob(utf8ToBytes('x'), new Uint8Array(16), adapter)).toThrow(PocketCryptoError);
  });
});
