import { describe, expect, it } from 'vitest';
import { resolveOutputPathTemplate } from '../../src/transports/outputPathTemplate.js';

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
