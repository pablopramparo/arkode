import { describe, expect, it } from 'vitest';
import { isTaskDue } from '../../src/scheduler/isTaskDue.js';
import type { BackupRun, BackupTask } from '../../src/types.js';

function makeTask(overrides: Partial<BackupTask> = {}): BackupTask {
  return {
    id: 't1',
    clientId: 'c1',
    strategy: 'fetch_existing',
    transportId: 'tr1',
    databaseConnectionId: null,
    name: 'task',
    dbEngine: 'unknown',
    scheduleTime: '03:00',
    scheduleEnabled: true,
    retentionCount: null,
    retentionDays: null,
    isActive: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeRun(startedAt: string): BackupRun {
  return {
    id: 'r1',
    taskId: 't1',
    clientId: 'c1',
    strategy: 'fetch_existing',
    transportId: 'tr1',
    databaseConnectionId: null,
    status: 'Success',
    remoteFileName: 'f.dump',
    remotePath: null,
    remoteModifiedAt: null,
    startedAt,
    finishedAt: startedAt,
    downloadedAt: startedAt,
    localPath: '/x',
    sizeBytes: 1,
    checksumSha256: 'x',
    durationMs: 1,
    errorMessage: null,
    errorStack: null,
    logFilePath: null,
    pid: 1,
    createdAt: startedAt,
  };
}

describe('isTaskDue', () => {
  it('is not due when scheduling is disabled', () => {
    const task = makeTask({ scheduleEnabled: false });
    expect(isTaskDue(task, new Date(2026, 0, 1, 10, 0), null)).toBe(false);
  });

  it('is not due when no schedule time is set', () => {
    const task = makeTask({ scheduleTime: null });
    expect(isTaskDue(task, new Date(2026, 0, 1, 10, 0), null)).toBe(false);
  });

  it('is not due when the task itself is inactive', () => {
    const task = makeTask({ isActive: false });
    expect(isTaskDue(task, new Date(2026, 0, 1, 10, 0), null)).toBe(false);
  });

  it('is not due before the scheduled time today, with no prior run', () => {
    const task = makeTask({ scheduleTime: '03:00' });
    expect(isTaskDue(task, new Date(2026, 0, 1, 2, 59), null)).toBe(false);
  });

  it('is due at or after the scheduled time today, with no prior run', () => {
    const task = makeTask({ scheduleTime: '03:00' });
    expect(isTaskDue(task, new Date(2026, 0, 1, 3, 0), null)).toBe(true);
    expect(isTaskDue(task, new Date(2026, 0, 1, 9, 0), null)).toBe(true);
  });

  it('is not due if any attempt already happened today, regardless of the scheduled time', () => {
    const task = makeTask({ scheduleTime: '03:00' });
    const runToday = makeRun(new Date(2026, 0, 1, 3, 0).toISOString());
    expect(isTaskDue(task, new Date(2026, 0, 1, 9, 0), runToday)).toBe(false);
  });

  it('is due again if the last attempt was on a previous day (a new day has started)', () => {
    const task = makeTask({ scheduleTime: '03:00' });
    const runYesterday = makeRun(new Date(2025, 11, 31, 3, 0).toISOString());
    expect(isTaskDue(task, new Date(2026, 0, 1, 9, 0), runYesterday)).toBe(true);
  });

  it('is due later the same day via a catch-up check if the scheduled time was missed (e.g. PC was off)', () => {
    const task = makeTask({ scheduleTime: '03:00' });
    // No run yet today, and it's now well past 03:00 — this is exactly the
    // LogonTrigger catch-up scenario.
    expect(isTaskDue(task, new Date(2026, 0, 1, 14, 30), null)).toBe(true);
  });
});
