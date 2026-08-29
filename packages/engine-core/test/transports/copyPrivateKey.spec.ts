import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { copyPrivateKeyIntoAppStorage } from '../../src/transports/copyPrivateKey.js';
import { withTempDir } from '../helpers/tempDir.js';

const FAKE_PRIVATE_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nZmFrZS1rZXktYnl0ZXM=\n-----END OPENSSH PRIVATE KEY-----\n';

describe('copyPrivateKeyIntoAppStorage', () => {
  it('copies the source file into the given directory under a new name, preserving content', async () => {
    await withTempDir(async (sourceDir) => {
      await withTempDir(async (keysDir) => {
        const sourcePath = join(sourceDir, 'id_rsa');
        writeFileSync(sourcePath, FAKE_PRIVATE_KEY);

        const destPath = await copyPrivateKeyIntoAppStorage(sourcePath, keysDir);

        expect(destPath).not.toBe(sourcePath);
        expect(destPath.startsWith(keysDir)).toBe(true);
        expect(readFileSync(destPath, 'utf8')).toBe(FAKE_PRIVATE_KEY);
      });
    });
  });

  it('creates the destination directory if it does not exist yet', async () => {
    await withTempDir(async (sourceDir) => {
      await withTempDir(async (tempDir) => {
        const keysDir = join(tempDir, 'nested', 'keys');
        const sourcePath = join(sourceDir, 'id_rsa');
        writeFileSync(sourcePath, FAKE_PRIVATE_KEY);

        const destPath = await copyPrivateKeyIntoAppStorage(sourcePath, keysDir);

        expect(readFileSync(destPath, 'utf8')).toBe(FAKE_PRIVATE_KEY);
      });
    });
  });

  it('gives each copy a distinct filename, even for the same source', async () => {
    await withTempDir(async (sourceDir) => {
      await withTempDir(async (keysDir) => {
        const sourcePath = join(sourceDir, 'id_rsa');
        writeFileSync(sourcePath, FAKE_PRIVATE_KEY);

        const first = await copyPrivateKeyIntoAppStorage(sourcePath, keysDir);
        const second = await copyPrivateKeyIntoAppStorage(sourcePath, keysDir);

        expect(first).not.toBe(second);
        expect(readdirSync(keysDir)).toHaveLength(2);
      });
    });
  });

  it('rejects a public key (.pub) with an actionable message, without copying', async () => {
    await withTempDir(async (sourceDir) => {
      await withTempDir(async (keysDir) => {
        const pubPath = join(sourceDir, 'id_ed25519.pub');
        writeFileSync(pubPath, 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOR7 user@host\n');

        await expect(copyPrivateKeyIntoAppStorage(pubPath, keysDir)).rejects.toThrow(/looks like a public key/i);
        expect(readdirSync(keysDir)).toHaveLength(0);
      });
    });
  });

  it('rejects a file with no PRIVATE KEY header', async () => {
    await withTempDir(async (sourceDir) => {
      await withTempDir(async (keysDir) => {
        const sourcePath = join(sourceDir, 'not-a-key.txt');
        writeFileSync(sourcePath, 'just some text\n');

        await expect(copyPrivateKeyIntoAppStorage(sourcePath, keysDir)).rejects.toThrow(/doesn't look like an SSH private key/i);
      });
    });
  });
});
