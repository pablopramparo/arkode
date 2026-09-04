import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withTempDir } from '../../helpers/tempDir.js';
import { directorySizeBytes } from '../../../src/fileBackup/restic/resticClient.js';

describe('directorySizeBytes', () => {
  it('sums file sizes recursively', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'a.bin'), Buffer.alloc(100));
      await mkdir(join(dir, 'sub'));
      await writeFile(join(dir, 'sub', 'b.bin'), Buffer.alloc(250));
      await writeFile(join(dir, 'sub', 'c.bin'), Buffer.alloc(0));

      expect(await directorySizeBytes(dir)).toBe(350);
    });
  });

  it('returns 0 for a directory that does not exist', async () => {
    expect(await directorySizeBytes(join('this', 'does', 'not', 'exist', '_restic-repo'))).toBe(0);
  });
});
