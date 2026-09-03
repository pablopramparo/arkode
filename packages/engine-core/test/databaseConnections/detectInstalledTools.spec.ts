import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectInstalledDbTools, __test } from '../../src/databaseConnections/detectInstalledTools.js';
import { withTempDir } from '../helpers/tempDir.js';

const { parseMajorMinor, expandGlob } = __test;

describe('parseMajorMinor', () => {
  it('parses PostgreSQL: major only from v10 on, major.minor before', () => {
    expect(parseMajorMinor('pg_dump', 'pg_dump (PostgreSQL) 17.2')).toBe('17');
    expect(parseMajorMinor('pg_restore', 'pg_restore (PostgreSQL) 9.6.24')).toBe('9.6');
  });

  it('parses MySQL / MariaDB as major.minor', () => {
    expect(parseMajorMinor('mysqldump', 'mysqldump  Ver 9.1.0 for Win64 on x86_64 (MySQL Community Server - GPL)')).toBe(
      '9.1'
    );
    expect(
      parseMajorMinor('mariadb-dump', 'mariadb-dump.exe from 11.4.4-MariaDB, client 10.19 for Win64 (AMD64)')
    ).toBe('11.4');
    expect(parseMajorMinor('mysql', 'mysql  Ver 8.0.36 for Win64 on x86_64')).toBe('8.0');
  });

  it('returns null for unparseable / missing input', () => {
    expect(parseMajorMinor('mysqldump', null)).toBeNull();
    expect(parseMajorMinor('pg_dump', 'no version here')).toBeNull();
  });
});

describe('expandGlob', () => {
  it('expands a single * segment against real subdirectories, case-insensitively', async () => {
    await withTempDir(async (dir) => {
      mkdirSync(join(dir, 'MySQL Server 8.0', 'bin'), { recursive: true });
      mkdirSync(join(dir, 'MySQL Server 9.1', 'bin'), { recursive: true });
      const results = expandGlob(join(dir, '*', 'bin'));
      expect(results.sort()).toEqual(
        [join(dir, 'MySQL Server 8.0', 'bin'), join(dir, 'MySQL Server 9.1', 'bin')].sort()
      );
    });
  });

  it('returns [] when the parent does not exist', () => {
    expect(expandGlob(join('Z:\\definitely-not-here', '*', 'bin'))).toEqual([]);
  });
});

describe('detectInstalledDbTools', () => {
  // NOTE: also scans this machine's real install locations, so assertions
  // filter to what was planted under the temp dir rather than checking the
  // whole result set.
  it('finds known exe names under an extra root and reports their path', async () => {
    await withTempDir(async (dir) => {
      const binDir = join(dir, 'bin');
      mkdirSync(binDir, { recursive: true });
      writeFileSync(join(binDir, 'mysqldump.exe'), '');
      writeFileSync(join(binDir, 'mysql.exe'), '');
      writeFileSync(join(binDir, 'irrelevant.exe'), '');

      const tools = await detectInstalledDbTools({ extraRoots: [binDir] });
      const planted = tools.filter((t) => t.path.startsWith(binDir));
      expect(planted.map((t) => t.kind).sort()).toEqual(['mysql', 'mysqldump']);
      // Empty files, so --version can't run — version/majorMinor are null, not a throw.
      expect(planted.every((t) => t.version === null && t.majorMinor === null)).toBe(true);
    });
    // detectInstalledDbTools also scans the real machine (Program Files /
    // WAMP / XAMPP / Laragon) and runs --version on whatever it finds — that
    // can blow past vitest's 5s default on a loaded CI runner. This test
    // isn't slow by design, so a generous ceiling rather than optimising it.
  }, 30_000);

  it('dedupes a bin dir passed as an extra root twice', async () => {
    await withTempDir(async (dir) => {
      const binDir = join(dir, 'bin');
      mkdirSync(binDir, { recursive: true });
      writeFileSync(join(binDir, 'psql.exe'), '');
      const tools = await detectInstalledDbTools({ extraRoots: [binDir, binDir] });
      expect(tools.filter((t) => t.path.startsWith(binDir) && t.kind === 'psql')).toHaveLength(1);
    });
  }, 30_000);
});
