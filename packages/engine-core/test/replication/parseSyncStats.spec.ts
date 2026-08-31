import { describe, expect, it } from 'vitest';
import { parseSyncStats } from '../../src/replication/rcloneClient.js';

// Real lines captured from the vendored rclone.exe with the exact flags
// rcloneSync uses (--use-json-log --stats-log-level NOTICE --stats 10s).
const STATS_LINE =
  '{"level":"warning","msg":"\\nTransferred:   \\t  341.797 KiB / 341.797 KiB, 100%, 0 B/s, ETA -\\nTransferred:            2 / 2, 100%\\nElapsed time:         0.0s\\n\\n","source":"accounting/stats.go:528","stats":{"bytes":350000,"deletes":0,"errors":0,"transfers":2},"time":"2026-08-31T11:14:27.798743-03:00"}';
const CONFIG_NOTICE =
  '{"level":"warning","msg":"Config file \\"C:\\\\Users\\\\x\\\\AppData\\\\Roaming\\\\rclone\\\\rclone.conf\\" not found - using defaults","source":"config/config.go:373","time":"2026-08-31T11:14:27.773216-03:00"}';
const REAL_WARNING =
  '{"level":"warning","msg":"Time may be set wrong - time is not set on the object","source":"drive/drive.go:1","time":"2026-08-31T11:14:27.9Z"}';

describe('parseSyncStats', () => {
  it('reads bytes/transfers/deletes from a stats line without treating it as a warning', () => {
    const { stats, warnings } = parseSyncStats(STATS_LINE);
    expect(stats).toEqual({ bytes: 350000, deletes: 0, errors: 0, transfers: 2 });
    expect(warnings).toEqual([]);
  });

  it('a clean multi-stats sync yields NO warnings (so the run is Success, not Warning)', () => {
    const { warnings } = parseSyncStats([STATS_LINE, STATS_LINE, STATS_LINE].join('\n'));
    expect(warnings).toEqual([]);
  });

  it('ignores the benign "config file not found - using defaults" notice', () => {
    expect(parseSyncStats(CONFIG_NOTICE).warnings).toEqual([]);
  });

  it('still surfaces a genuine warning line (no stats field)', () => {
    const { warnings } = parseSyncStats([STATS_LINE, REAL_WARNING].join('\n'));
    expect(warnings).toEqual(['Time may be set wrong - time is not set on the object']);
  });

  it('ignores non-JSON lines', () => {
    expect(parseSyncStats('just some text\nnot json\n')).toEqual({ stats: {}, warnings: [] });
  });
});
