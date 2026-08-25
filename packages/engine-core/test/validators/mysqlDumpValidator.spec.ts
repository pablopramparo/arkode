import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMysqlDumpValidator } from '../../src/validators/mysqlDumpValidator.js';
import { withTempDir } from '../helpers/tempDir.js';

const REAL_MYSQLDUMP_OUTPUT = `-- MySQL dump 10.13  Distrib 9.1.0, for Win64 (x86_64)
--
-- Host: 127.0.0.1    Database: mysql
-- ------------------------------------------------------
-- Server version	9.1.0

CREATE TABLE \`example\` (\`id\` int(11) NOT NULL);

-- Dump completed on 2026-08-24 20:27:46
`;

const REAL_MARIADB_DUMP_OUTPUT = `/*M!999999\\- enable the sandbox mode */
-- MariaDB dump 10.19-11.5.2-MariaDB, for Win64 (AMD64)
--
-- Host: 127.0.0.1    Database: mysql
-- ------------------------------------------------------

CREATE TABLE \`example\` (\`id\` int(11) NOT NULL);

-- Dump completed on 2026-08-24 20:27:58
`;

describe('mysqlDumpValidator', () => {
  it('is valid for a real mysqldump-shaped file (header + completion footer)', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'backup.sql');
      await writeFile(path, REAL_MYSQLDUMP_OUTPUT);

      const result = await createMysqlDumpValidator().validate(path);
      expect(result.valid).toBe(true);
    });
  });

  it('is valid for a real mariadb-dump-shaped file (same completion footer)', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'backup.sql');
      await writeFile(path, REAL_MARIADB_DUMP_OUTPUT);

      const result = await createMysqlDumpValidator().validate(path);
      expect(result.valid).toBe(true);
    });
  });

  it('is invalid when the completion footer is missing (truncated dump)', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'backup.sql');
      const truncated = REAL_MYSQLDUMP_OUTPUT.split('-- Dump completed on')[0];
      await writeFile(path, truncated);

      const result = await createMysqlDumpValidator().validate(path);
      expect(result.valid).toBe(false);
      expect(result.details).toMatch(/completed/i);
    });
  });

  it('is invalid when the file has no recognizable mysqldump/mariadb-dump header', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'backup.sql');
      await writeFile(path, 'this is not a real dump at all, just some random text\n-- Dump completed on 2026-01-01');

      const result = await createMysqlDumpValidator().validate(path);
      expect(result.valid).toBe(false);
      expect(result.details).toMatch(/header/i);
    });
  });

  it('is invalid for a missing file', async () => {
    await withTempDir(async (dir) => {
      const result = await createMysqlDumpValidator().validate(join(dir, 'missing.sql'));
      expect(result.valid).toBe(false);
    });
  });

  it('only reads the head/tail, not the whole file — works even on a dump larger than the read window', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'big.sql');
      const middle = 'X'.repeat(10_000);
      const content = REAL_MYSQLDUMP_OUTPUT.replace(
        '-- Dump completed on',
        `-- filler\n${middle}\n-- Dump completed on`
      );
      await writeFile(path, content);

      const result = await createMysqlDumpValidator().validate(path);
      expect(result.valid).toBe(true);
    });
  });
});
