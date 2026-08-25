import { describe, expect, it } from 'vitest';
import { toResticPath, fromResticPath } from '../../../src/fileBackup/restic/paths.js';

describe('toResticPath / fromResticPath', () => {
  it('converts an absolute Windows path to restic\'s internal /C/... form', () => {
    expect(toResticPath('C:\\Users\\pablo\\uploads\\file.bin')).toBe('/C/Users/pablo/uploads/file.bin');
  });

  it('uppercases the drive letter', () => {
    expect(toResticPath('d:\\backups\\acme')).toBe('/D/backups/acme');
  });

  it('throws on a non-absolute-Windows-path input', () => {
    expect(() => toResticPath('/already/posix')).toThrow(/absolute Windows path/);
    expect(() => toResticPath('relative\\path')).toThrow(/absolute Windows path/);
  });

  it('fromResticPath is the inverse of toResticPath', () => {
    const original = 'C:\\Users\\pablo\\uploads\\file.bin';
    expect(fromResticPath(toResticPath(original))).toBe(original);
  });
});
