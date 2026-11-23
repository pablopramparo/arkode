import Database from 'better-sqlite3';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { latestHourlySlot, nextHourlySlot } from '../../src/scheduler/hourlySlots.js';
import { isTaskDue } from '../../src/scheduler/isTaskDue.js';
import { isFileBackupTaskDue } from '../../src/fileBackup/scheduler/isFileBackupTaskDue.js';
import { nextScheduledRunAt } from '../../src/scheduler/nextOccurrence.js';
import { runMigrations } from '../../src/db/migrate.js';
import { migrationsSourceDir } from '../../src/paths.js';
import type { BackupRun, BackupTask } from '../../src/types.js';
import type { FileBackupRun, FileBackupTask } from '../../src/fileBackup/types.js';
import { createTestContext } from '../helpers/testContext.js';

const d = (h: number, m = 0, day = 10) => new Date(2026, 5, day, h, m, 0, 0);

describe('hourly slots', () => {
  it('anchor 03:00 every 6h → 03, 09, 15, 21', () => {
    expect(latestHourlySlot('03:00', 6, d(10))).toEqual(d(9));
    expect(latestHourlySlot('03:00', 6, d(9))).toEqual(d(9)); // exactly on the slot
    expect(latestHourlySlot('03:00', 6, d(21, 30))).toEqual(d(21));
    expect(nextHourlySlot('03:00', 6, d(10))).toEqual(d(15));
    expect(nextHourlySlot('03:00', 6, d(21, 30))).toEqual(d(3, 0, 11));
  });

  it('slots before the anchor on the same day exist (previous-cycle turns)', () => {
    // 05:00 every 4h → 01, 05, 09, 13, 17, 21
    expect(latestHourlySlot('05:00', 4, d(2))).toEqual(d(1));
    // 03:00 every 6h at 01:00 → the previous day's 21:00 slot
    expect(latestHourlySlot('03:00', 6, d(1))).toEqual(d(21, 0, 9));
  });

  it('every hour and midnight anchor', () => {
    expect(latestHourlySlot('00:00', 1, d(7, 45))).toEqual(d(7));
    expect(latestHourlySlot('00:30', 1, d(7, 15))).toEqual(d(6, 30));
  });

  it('rejects an interval that is not a divisor of 24', () => {
    expect(latestHourlySlot('03:00', 5, d(10))).toBeNull();
  });
});

function task(over: Partial<BackupTask> = {}): BackupTask {
  return {
    id: 't', clientId: 'c', strategy: 'fetch_existing', transportId: 'x', databaseConnectionId: null, name: 'n',
    dbEngine: 'unknown', scheduleTime: '03:00', scheduleEnabled: true, scheduleFrequency: 'hourly', scheduleDaysOfWeek: null,
    scheduleDayOfMonth: null, scheduleIntervalHours: 6, retentionCount: null, retentionDays: null, isActive: true,
    createdAt: '', updatedAt: '', ...over,
  } as BackupTask;
}
const run = (at: Date) => ({ startedAt: at.toISOString(), trigger: 'scheduled' }) as unknown as BackupRun;

describe('isTaskDue — hourly', () => {
  it('is due when the current slot has no scheduled run yet', () => {
    expect(isTaskDue(task(), d(9, 5), null)).toBe(true);
    expect(isTaskDue(task(), d(9, 5), run(d(3, 1)))).toBe(true); // last run belongs to the 03:00 slot
  });

  it('is not due once a scheduled run started in (or after) the current slot', () => {
    expect(isTaskDue(task(), d(9, 5), run(d(9, 1)))).toBe(false);
    expect(isTaskDue(task(), d(11, 59), run(d(9, 0)))).toBe(false);
  });

  it('missed slots collapse into one run', () => {
    // PC was off from 03:00 to 22:00: only the 21:00 slot matters; one run satisfies it.
    expect(isTaskDue(task(), d(22), run(d(3, 1)))).toBe(true);
    expect(isTaskDue(task(), d(22), run(d(22, 1)))).toBe(false);
  });

  it('runs across midnight: previous-day slot satisfied by a late run', () => {
    expect(isTaskDue(task(), d(1, 0, 11), run(d(21, 2)))).toBe(false); // 21:00 slot done, next is 03:00
    expect(isTaskDue(task(), d(3, 0, 11), run(d(21, 2)))).toBe(true);
  });

  it('respects disabled/inactive and a missing interval', () => {
    expect(isTaskDue(task({ scheduleEnabled: false }), d(9, 5), null)).toBe(false);
    expect(isTaskDue(task({ isActive: false }), d(9, 5), null)).toBe(false);
    expect(isTaskDue(task({ scheduleIntervalHours: null }), d(9, 5), null)).toBe(false);
  });

  it('daily behaviour is unchanged', () => {
    const daily = task({ scheduleFrequency: 'daily', scheduleIntervalHours: null });
    expect(isTaskDue(daily, d(9, 5), null)).toBe(true);
    expect(isTaskDue(daily, d(9, 5), run(d(3, 1)))).toBe(false); // one per day
  });
});

describe('isFileBackupTaskDue — hourly', () => {
  const ft = (over: Partial<FileBackupTask> = {}) =>
    ({ id: 't', isActive: true, scheduleEnabled: true, scheduleTime: '03:00', scheduleFrequency: 'hourly', scheduleIntervalHours: 6,
      scheduleDaysOfWeek: null, scheduleDayOfMonth: null, ...over }) as FileBackupTask;
  const fr = (at: Date) => ({ startedAt: at.toISOString() }) as unknown as FileBackupRun;

  it('ignores a manual run (only the scheduled one counts)', () => {
    // latestRun = a manual run at 09:02, no scheduled run → still due.
    expect(isFileBackupTaskDue(ft(), d(9, 5), fr(d(9, 2)), null)).toBe(true);
    expect(isFileBackupTaskDue(ft(), d(9, 5), fr(d(9, 2)), fr(d(9, 1)))).toBe(false);
    expect(isFileBackupTaskDue(ft(), d(9, 5), fr(d(9, 2)), fr(d(3, 1)))).toBe(true);
  });

  it('daily file tasks still use the any-run-today check', () => {
    const daily = ft({ scheduleFrequency: 'daily', scheduleIntervalHours: null });
    expect(isFileBackupTaskDue(daily, d(9, 5), fr(d(3, 1)))).toBe(false);
  });
});

describe('nextScheduledRunAt — hourly', () => {
  const s = { scheduleEnabled: true, scheduleTime: '03:00', scheduleFrequency: 'hourly' as const, scheduleDaysOfWeek: null, scheduleDayOfMonth: null, scheduleIntervalHours: 6 };
  it('returns the next slot after now', () => {
    expect(nextScheduledRunAt(s, d(10), false)).toEqual(d(15));
    expect(nextScheduledRunAt(s, d(22), true)).toEqual(d(3, 0, 11));
  });
  it('null without an interval', () => {
    expect(nextScheduledRunAt({ ...s, scheduleIntervalHours: null }, d(10), false)).toBeNull();
  });
});

describe('setSchedule — hourly', () => {
  function seed(ctx: ReturnType<typeof createTestContext>) {
    const client = ctx.clientsRepo.create({ name: 'C', localBasePath: 'D:\\b' });
    const transport = ctx.transportsRepo.createSftp({ clientId: client.id, name: 't', host: 'h', port: 22, username: 'u', privateKeyPath: 'k' });
    return ctx.tasksRepo.createFetchExisting({ clientId: client.id, transportId: transport.id, name: 'task', dbEngine: 'unknown', remotePath: '/b' });
  }

  it('stores the interval, clears days/month, and rejects invalid intervals', () => {
    const ctx = createTestContext();
    const t = seed(ctx);
    const u = ctx.tasksRepo.setSchedule(t.id, { scheduleTime: '03:00', scheduleEnabled: true, scheduleFrequency: 'hourly', scheduleIntervalHours: 6 });
    expect(u.scheduleFrequency).toBe('hourly');
    expect(u.scheduleIntervalHours).toBe(6);
    expect(u.scheduleDaysOfWeek).toBeNull();

    expect(() => ctx.tasksRepo.setSchedule(t.id, { scheduleTime: '03:00', scheduleEnabled: true, scheduleFrequency: 'hourly', scheduleIntervalHours: 5 })).toThrow(/divisors of 24/);
    expect(() => ctx.tasksRepo.setSchedule(t.id, { scheduleTime: '03:00', scheduleEnabled: true, scheduleFrequency: 'hourly', scheduleIntervalHours: null })).toThrow();

    const back = ctx.tasksRepo.setSchedule(t.id, { scheduleTime: '03:00', scheduleEnabled: true, scheduleFrequency: 'daily' });
    expect(back.scheduleIntervalHours).toBeNull();
  });
});

describe('migration 0024 preserves existing data', () => {
  it('keeps tasks (both domains) and runs intact when upgrading from 0023', () => {
    const dir = mkdtempSync(join(tmpdir(), 'arkode-mig-'));
    try {
      const src = migrationsSourceDir();
      for (const f of readdirSync(src)) if (f.endsWith('.sql') && f < '0024') cpSync(join(src, f), join(dir, f));
      const db = new Database(':memory:');
      db.pragma('foreign_keys = ON');
      runMigrations(db, dir);

      db.prepare(`INSERT INTO clients (id, name, local_base_path) VALUES ('c1','C','D:\\b')`).run();
      db.prepare(`INSERT INTO transports (id, client_id, name, type, host, port, username, private_key_path) VALUES ('tr1','c1','t','sftp','h',22,'u','k')`).run();
      db.prepare(`INSERT INTO backup_tasks (id, client_id, strategy, transport_id, name, db_engine, remote_path, schedule_time, schedule_frequency, schedule_days_of_week)
                  VALUES ('bt1','c1','fetch_existing','tr1','n','unknown','/b','04:30','weekly','1,3')`).run();
      db.prepare(`INSERT INTO backup_runs (id, task_id, client_id, strategy, status, started_at, pid) VALUES ('br1','bt1','c1','fetch_existing','Success','2026-01-01T00:00:00Z',1)`).run();
      db.prepare(`INSERT INTO file_backup_repositories (id, client_id, repo_path, password_secret_ref) VALUES ('fr1','c1','D:\\b\\_restic-repo','ref')`).run();
      db.prepare(`INSERT INTO file_backup_tasks (id, client_id, repository_id, name, source_kind, source_path, schedule_time, schedule_frequency)
                  VALUES ('ft1','c1','fr1','f','local_folder','D:\\src','05:00','monthly')`).run();
      db.prepare(`INSERT INTO file_backup_runs (id, task_id, client_id, repository_id, status, started_at, pid) VALUES ('fru1','ft1','c1','fr1','Success','2026-01-01T00:00:00Z',1)`).run();

      runMigrations(db, migrationsSourceDir()); // applies 0024 (+ anything newer)

      const bt = db.prepare('SELECT * FROM backup_tasks WHERE id = ?').get('bt1') as Record<string, unknown>;
      expect(bt.schedule_time).toBe('04:30');
      expect(bt.schedule_frequency).toBe('weekly');
      expect(bt.schedule_days_of_week).toBe('1,3');
      expect(bt.schedule_interval_hours).toBeNull();
      const ft = db.prepare('SELECT * FROM file_backup_tasks WHERE id = ?').get('ft1') as Record<string, unknown>;
      expect(ft.schedule_frequency).toBe('monthly');
      expect(ft.schedule_interval_hours).toBeNull();
      expect((db.prepare('SELECT trigger FROM backup_runs WHERE id = ?').get('br1') as { trigger: string }).trigger).toBe('manual');
      expect((db.prepare('SELECT trigger FROM file_backup_runs WHERE id = ?').get('fru1') as { trigger: string }).trigger).toBe('manual');
      expect(db.pragma('foreign_key_check')).toEqual([]);

      db.prepare(`UPDATE backup_tasks SET schedule_frequency='hourly', schedule_interval_hours=6 WHERE id='bt1'`).run();
      db.prepare(`UPDATE file_backup_tasks SET schedule_frequency='hourly', schedule_interval_hours=6 WHERE id='ft1'`).run();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
