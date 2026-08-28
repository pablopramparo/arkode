import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveBundledToolPath, resolveToolPath } from '../src/toolPaths.js';
import { withTempDir } from './helpers/tempDir.js';

const ORIGINAL_EXEC_PATH = process.execPath;

beforeEach(() => {
  delete process.env.__TOOLPATHS_TEST;
});

afterEach(() => {
  process.execPath = ORIGINAL_EXEC_PATH;
  delete process.env.__TOOLPATHS_TEST;
});

describe('resolveToolPath', () => {
  it('returns an explicitly-set env var verbatim, without touching the filesystem', () => {
    process.env.__TOOLPATHS_TEST = 'C:\\somewhere\\custom\\pg_restore.exe';
    expect(resolveToolPath('__TOOLPATHS_TEST', 'pg_restore.exe')).toBe('C:\\somewhere\\custom\\pg_restore.exe');
  });

  it('ignores a blank/whitespace env var and falls through to the bundled lookup', () => {
    process.env.__TOOLPATHS_TEST = '   ';
    // No sibling resources/ dir next to node.exe -> undefined.
    expect(resolveToolPath('__TOOLPATHS_TEST', 'pg_restore.exe')).toBeUndefined();
  });

  it('falls back to a tool vendored next to the running executable when the env var is unset', async () => {
    await withTempDir(async (dir) => {
      const binDir = join(dir, 'resources', 'pgsql', 'bin');
      mkdirSync(binDir, { recursive: true });
      const toolPath = join(binDir, 'pg_restore.exe');
      writeFileSync(toolPath, 'fake');
      process.execPath = join(dir, 'engine-cli.exe');

      expect(resolveToolPath('__TOOLPATHS_TEST', 'pg_restore.exe')).toBe(toolPath);
    });
  });

  it('returns undefined for a tool that is never vendored (e.g. mysqldump, GPLv2) with no env var', () => {
    expect(resolveToolPath('__TOOLPATHS_TEST', 'mysqldump.exe')).toBeUndefined();
  });
});

describe('resolveBundledToolPath', () => {
  it('returns undefined when no sibling resources/ file exists', () => {
    expect(resolveBundledToolPath('restic.exe')).toBeUndefined();
  });

  it('returns undefined for an unknown tool name regardless of the filesystem', () => {
    expect(resolveBundledToolPath('totally-unknown-tool.exe')).toBeUndefined();
  });
});
