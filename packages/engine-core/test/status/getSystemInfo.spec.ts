import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getSystemInfo } from '../../src/status/getSystemInfo.js';
import { withTempDir } from '../helpers/tempDir.js';

const ENV_VARS = ['PG_DUMP_PATH', 'PG_RESTORE_PATH', 'PSQL_PATH', 'MYSQLDUMP_PATH', 'MYSQL_CLI_PATH'] as const;

afterEach(() => {
  for (const name of ENV_VARS) delete process.env[name];
});

describe('getSystemInfo', () => {
  it('reports appDataDir/dbFilePath/logsDir consistent with CODEBIUS_APP_DATA_DIR', () => {
    const info = getSystemInfo();
    expect(info.dbFilePath.startsWith(info.appDataDir)).toBe(true);
    expect(info.logsDir.startsWith(info.appDataDir)).toBe(true);
  });

  it('reports a tool as not configured when its env var is unset', () => {
    const info = getSystemInfo();
    const pgDump = info.tools.find((t) => t.envVar === 'PG_DUMP_PATH');
    expect(pgDump).toMatchObject({ path: null, exists: false });
  });

  it('reports configured-but-missing when the env var points at a nonexistent file', () => {
    process.env.PG_DUMP_PATH = 'C:/does/not/exist/pg_dump.exe';

    const info = getSystemInfo();

    const pgDump = info.tools.find((t) => t.envVar === 'PG_DUMP_PATH');
    expect(pgDump).toMatchObject({ path: 'C:/does/not/exist/pg_dump.exe', exists: false });
  });

  it('reports exists:true when the env var points at a real file', async () => {
    await withTempDir(async (dir) => {
      const fakeBinary = join(dir, 'pg_dump.exe');
      await writeFile(fakeBinary, 'fake');
      process.env.PG_DUMP_PATH = fakeBinary;

      const info = getSystemInfo();

      const pgDump = info.tools.find((t) => t.envVar === 'PG_DUMP_PATH');
      expect(pgDump).toMatchObject({ path: fakeBinary, exists: true });
    });
  });

  it('includes all five known tool env vars', () => {
    const info = getSystemInfo();
    expect(info.tools.map((t) => t.envVar).sort()).toEqual([...ENV_VARS].sort());
  });
});
