import { describe, expect, it } from 'vitest';
import { resolvePrivateKeyMaterial } from '../../src/transports/privateKeyMaterial.js';
import { withTempDir } from '../helpers/tempDir.js';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('resolvePrivateKeyMaterial', () => {
  it('returns in-memory bytes verbatim when `privateKey` is set (no file needed)', async () => {
    const bytes = Buffer.from('-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----\n');
    const out = await resolvePrivateKeyMaterial({ privateKey: bytes });
    expect(out.equals(bytes)).toBe(true);
  });

  it('reads the file when only `privateKeyPath` is set', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'id.key');
      await writeFile(path, 'key-file-contents');
      const out = await resolvePrivateKeyMaterial({ privateKeyPath: path });
      expect(out.toString('utf8')).toBe('key-file-contents');
    });
  });

  it('prefers in-memory bytes over a path when both are present', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'id.key');
      await writeFile(path, 'from-file');
      const out = await resolvePrivateKeyMaterial({ privateKey: Buffer.from('from-memory'), privateKeyPath: path });
      expect(out.toString('utf8')).toBe('from-memory');
    });
  });

  it('throws a clear error when neither is provided', async () => {
    await expect(resolvePrivateKeyMaterial({})).rejects.toThrow(/private key material/i);
  });
});
