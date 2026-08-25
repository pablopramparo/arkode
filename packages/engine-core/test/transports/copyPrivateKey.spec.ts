import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { copyPrivateKeyIntoAppStorage } from '../../src/transports/copyPrivateKey.js';
import { withTempDir } from '../helpers/tempDir.js';

describe('copyPrivateKeyIntoAppStorage', () => {
  it('copies the source file into the given directory under a new name, preserving content', async () => {
    await withTempDir(async (sourceDir) => {
      await withTempDir(async (keysDir) => {
        const sourcePath = join(sourceDir, 'id_rsa');
        writeFileSync(sourcePath, 'the-actual-key-bytes');

        const destPath = copyPrivateKeyIntoAppStorage(sourcePath, keysDir);

        expect(destPath).not.toBe(sourcePath);
        expect(destPath.startsWith(keysDir)).toBe(true);
        expect(readFileSync(destPath, 'utf8')).toBe('the-actual-key-bytes');
      });
    });
  });

  it('creates the destination directory if it does not exist yet', async () => {
    await withTempDir(async (sourceDir) => {
      await withTempDir(async (tempDir) => {
        const keysDir = join(tempDir, 'nested', 'keys');
        const sourcePath = join(sourceDir, 'id_rsa');
        writeFileSync(sourcePath, 'key-bytes');

        const destPath = copyPrivateKeyIntoAppStorage(sourcePath, keysDir);

        expect(readFileSync(destPath, 'utf8')).toBe('key-bytes');
      });
    });
  });

  it('gives each copy a distinct filename, even for the same source', async () => {
    await withTempDir(async (sourceDir) => {
      await withTempDir(async (keysDir) => {
        const sourcePath = join(sourceDir, 'id_rsa');
        writeFileSync(sourcePath, 'key-bytes');

        const first = copyPrivateKeyIntoAppStorage(sourcePath, keysDir);
        const second = copyPrivateKeyIntoAppStorage(sourcePath, keysDir);

        expect(first).not.toBe(second);
        expect(readdirSync(keysDir)).toHaveLength(2);
      });
    });
  });
});
