/**
 * Zero-dependency byte utilities shared by every platform. Deliberately does
 * NOT use `Buffer` (not guaranteed to exist in a React Native / Hermes
 * runtime without a polyfill) — this package must stay importable from both
 * `node:crypto`-backed code (Desktop) and a JSI-backed mobile crypto adapter
 * with nothing more than plain `Uint8Array`.
 */

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_LOOKUP: ReadonlyMap<string, number> = new Map(
  Array.from(BASE64_ALPHABET).map((char, index) => [char, index])
);

export function bytesToBase64(bytes: Uint8Array): string {
  let result = '';
  let i = 0;
  for (; i + 3 <= bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    result +=
      BASE64_ALPHABET[(n >> 18) & 63] +
      BASE64_ALPHABET[(n >> 12) & 63] +
      BASE64_ALPHABET[(n >> 6) & 63] +
      BASE64_ALPHABET[n & 63];
  }
  const remaining = bytes.length - i;
  if (remaining === 1) {
    const n = bytes[i] << 16;
    result += BASE64_ALPHABET[(n >> 18) & 63] + BASE64_ALPHABET[(n >> 12) & 63] + '==';
  } else if (remaining === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    result +=
      BASE64_ALPHABET[(n >> 18) & 63] + BASE64_ALPHABET[(n >> 12) & 63] + BASE64_ALPHABET[(n >> 6) & 63] + '=';
  }
  return result;
}

export function base64ToBytes(b64: string): Uint8Array {
  const out: number[] = [];
  let buffer = 0;
  let bitsCollected = 0;
  for (const char of b64) {
    if (char === '=') break;
    const value = BASE64_LOOKUP.get(char);
    if (value === undefined) continue; // skip whitespace/newlines
    buffer = (buffer << 6) | value;
    bitsCollected += 6;
    if (bitsCollected >= 8) {
      bitsCollected -= 8;
      out.push((buffer >> bitsCollected) & 0xff);
    }
  }
  return new Uint8Array(out);
}

export function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** Not constant-time in the cryptographic sense — used only for a public magic-byte check, never for secrets. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// Both Node (18+) and modern Hermes (React Native 0.74+ / Expo SDK 51+)
// provide TextEncoder/TextDecoder as globals — no polyfill dependency added
// here. If an older Hermes ever lacks them, the mobile app's entry point can
// import the `text-encoding` polyfill before anything else.
export function utf8ToBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function bytesToUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}
