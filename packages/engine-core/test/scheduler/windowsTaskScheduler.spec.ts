import { describe, expect, it } from 'vitest';
import { parseArkodeTaskNamesFromCsv, scheduledTaskDisplayName } from '../../src/scheduler/windowsTaskScheduler.js';

describe('scheduledTaskDisplayName', () => {
  it('embeds the task name and a short id suffix under the arkode folder', () => {
    expect(scheduledTaskDisplayName('9138b5d9-f62b-4636-8b3d-7080d71f3f87', 'Rivera Web Mysql')).toBe(
      '\\arkode\\Rivera Web Mysql (9138b5d9)'
    );
  });

  it('strips characters Windows Task Scheduler names cannot contain', () => {
    expect(scheduledTaskDisplayName('abcdef12-0000-0000-0000-000000000000', 'Backup: Site/Prod <main>')).toBe(
      '\\arkode\\Backup_ Site_Prod _main_ (abcdef12)'
    );
  });

  it('falls back to a generic label for a name that is empty after sanitizing', () => {
    expect(scheduledTaskDisplayName('abcdef12-0000-0000-0000-000000000000', '   ')).toBe('\\arkode\\tarea (abcdef12)');
  });

  it('two tasks with the same display name get different registered names, via the id suffix', () => {
    const a = scheduledTaskDisplayName('11111111-0000-0000-0000-000000000000', 'Backup diario');
    const b = scheduledTaskDisplayName('22222222-0000-0000-0000-000000000000', 'Backup diario');
    expect(a).not.toBe(b);
  });
});

describe('parseArkodeTaskNamesFromCsv', () => {
  // Real `schtasks /Query /FO CSV /NH` shape: every field quoted, first
  // column is the full \folder\task path. The status column is localized
  // ("Listo" / "En ejecución" here) — the parser must not depend on it.
  const csv = [
    '"\\ActionLauncher_pablo","N/A","En ejecución"',
    '"\\Adobe Acrobat Update Task","30/8/2026 09:00:00","Listo"',
    '"\\arkode\\5c441f4e-88aa-46db-8e5b-5f35e7ea8bc8","30/8/2026 13:00:00","Listo"',
    '"\\arkode\\Compagnucci Ventas Mysql (2753be50)","30/8/2026 22:00:00","Listo"',
    '"\\arkode\\file-backup-maintenance","30/8/2026 04:00:00","Listo"',
    '"\\Mozilla\\Firefox Background Update","30/8/2026 03:02:34","Listo"',
  ].join('\r\n');

  it('extracts every \\arkode\\ task path, regardless of the localized status column', () => {
    expect(parseArkodeTaskNamesFromCsv(csv)).toEqual([
      '\\arkode\\5c441f4e-88aa-46db-8e5b-5f35e7ea8bc8',
      '\\arkode\\Compagnucci Ventas Mysql (2753be50)',
      '\\arkode\\file-backup-maintenance',
    ]);
  });

  it('ignores non-arkode tasks and de-dupes repeated rows', () => {
    const dupes = ['"\\arkode\\foo (abc12345)","N/A","Listo"', '"\\arkode\\foo (abc12345)","N/A","Listo"'].join('\n');
    expect(parseArkodeTaskNamesFromCsv(dupes)).toEqual(['\\arkode\\foo (abc12345)']);
  });

  it('returns [] for empty or headerful-only output', () => {
    expect(parseArkodeTaskNamesFromCsv('')).toEqual([]);
    expect(parseArkodeTaskNamesFromCsv('"TaskName","Next Run Time","Status"')).toEqual([]);
  });
});
