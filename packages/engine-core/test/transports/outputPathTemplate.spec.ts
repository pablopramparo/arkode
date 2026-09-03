import { describe, expect, it } from 'vitest';
import { resolveOutputPathTemplate, applyRemoteCommandOutputPath } from '../../src/transports/outputPathTemplate.js';

describe('resolveOutputPathTemplate', () => {
  it('substitutes a {date:FORMAT} token using the given date', () => {
    const now = new Date(2026, 7, 23, 3, 5, 9); // 2026-08-23 03:05:09 local
    const result = resolveOutputPathTemplate('/tmp/backups/winners_{date:YYYYMMDD_HHmm}.dump', now);
    expect(result).toBe('/tmp/backups/winners_20260823_0305.dump');
  });

  it('supports seconds and leaves literal path segments untouched', () => {
    const now = new Date(2026, 0, 1, 0, 0, 5);
    const result = resolveOutputPathTemplate('/tmp/x_{date:YYYYMMDD_HHmmss}.sql', now);
    expect(result).toBe('/tmp/x_20260101_000005.sql');
  });

  it('leaves a template with no token untouched', () => {
    expect(resolveOutputPathTemplate('/tmp/fixed-name.dump')).toBe('/tmp/fixed-name.dump');
  });

  it('resolves multiple tokens independently', () => {
    const now = new Date(2026, 5, 15, 12, 0, 0);
    const result = resolveOutputPathTemplate('/tmp/{date:YYYY}/{date:MM}/{date:DD}/dump.sql', now);
    expect(result).toBe('/tmp/2026/06/15/dump.sql');
  });
});

describe('applyRemoteCommandOutputPath', () => {
  it('substitutes {outputPath} with the shell-quoted resolved path', () => {
    const out = applyRemoteCommandOutputPath(
      'mysqldump --single-transaction web > {outputPath}',
      '/home/arkode-backup/dump_20260903_1530.sql'
    );
    expect(out).toBe("mysqldump --single-transaction web > '/home/arkode-backup/dump_20260903_1530.sql'");
  });

  it('replaces every occurrence', () => {
    const out = applyRemoteCommandOutputPath('sh -c "d > {outputPath} && gzip {outputPath}"', '/tmp/a.sql');
    expect(out).toBe(`sh -c "d > '/tmp/a.sql' && gzip '/tmp/a.sql'"`);
  });

  it('leaves a command with no placeholder untouched (pre-existing tasks unaffected)', () => {
    const cmd = 'mysqldump web > /home/arkode-backup/dump_$(date +%Y%m%d_%H%M).sql';
    expect(applyRemoteCommandOutputPath(cmd, '/ignored')).toBe(cmd);
  });

  it('shell-quotes a resolved path containing spaces', () => {
    const out = applyRemoteCommandOutputPath('pg_dump db > {outputPath}', '/home/my client/db.dump');
    expect(out).toBe("pg_dump db > '/home/my client/db.dump'");
  });
});
