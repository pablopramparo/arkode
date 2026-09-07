import { describe, expect, it } from 'vitest';
import { base64ToBytes, bytesToBase64, bytesToUtf8, concatBytes, utf8ToBytes } from '../src/bytes.js';

describe('bytes utilities (zero-dependency, no Buffer)', () => {
  it('round-trips base64 for various lengths (padding edge cases)', () => {
    for (const len of [0, 1, 2, 3, 4, 5, 15, 16, 17, 32, 100]) {
      const bytes = new Uint8Array(len).map((_, i) => i % 256);
      const encoded = bytesToBase64(bytes);
      const decoded = base64ToBytes(encoded);
      expect(Buffer.from(decoded).equals(Buffer.from(bytes))).toBe(true);
    }
  });

  it('matches Node Buffer base64 output exactly', () => {
    const bytes = new Uint8Array([1, 2, 3, 250, 251, 252, 0, 255]);
    expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
  });

  it('round-trips utf8', () => {
    const text = 'Rivera · MySQL · áéíóú';
    expect(bytesToUtf8(utf8ToBytes(text))).toBe(text);
  });

  it('concatBytes preserves order and length', () => {
    const out = concatBytes([new Uint8Array([1, 2]), new Uint8Array([]), new Uint8Array([3])]);
    expect(Array.from(out)).toEqual([1, 2, 3]);
  });
});
