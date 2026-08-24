import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createGenericValidator } from '../../src/validators/genericValidator.js';
import { withTempDir } from '../helpers/tempDir.js';

describe('genericValidator', () => {
  it('is valid for a file that exists and has content', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'backup.dump');
      await writeFile(path, 'some real backup bytes');

      const result = await createGenericValidator().validate(path);
      expect(result.valid).toBe(true);
      expect(result.warnings).toEqual([]);
    });
  });

  it('is invalid for a file that does not exist', async () => {
    await withTempDir(async (dir) => {
      const result = await createGenericValidator().validate(join(dir, 'missing.dump'));
      expect(result.valid).toBe(false);
      expect(result.details).toMatch(/does not exist/i);
    });
  });

  it('is invalid for an empty file', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'empty.dump');
      await writeFile(path, '');

      const result = await createGenericValidator().validate(path);
      expect(result.valid).toBe(false);
      expect(result.details).toMatch(/empty/i);
    });
  });
});
