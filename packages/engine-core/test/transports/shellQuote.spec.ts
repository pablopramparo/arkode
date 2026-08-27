import { describe, expect, it } from 'vitest';
import { shellQuote } from '../../src/transports/shellQuote.js';

describe('shellQuote', () => {
  it('wraps a plain value in single quotes', () => {
    expect(shellQuote('rivera_web')).toBe("'rivera_web'");
  });

  it('escapes an embedded single quote using the standard POSIX close-escape-reopen technique', () => {
    expect(shellQuote("o'brien")).toBe("'o'\\''brien'");
  });

  it('is a no-op-safe wrapper for an empty string', () => {
    expect(shellQuote('')).toBe("''");
  });

  it('does not need to touch other shell metacharacters — single quotes are literal inside single quotes', () => {
    expect(shellQuote('a; rm -rf / #$(whoami)')).toBe("'a; rm -rf / #$(whoami)'");
  });
});
