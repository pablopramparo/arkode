import { describe, expect, it } from 'vitest';
import { scheduledTaskDisplayName } from '../../src/scheduler/windowsTaskScheduler.js';

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
