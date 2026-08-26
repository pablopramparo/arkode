import { describe, expect, it } from 'vitest';
import { isFileBackupTaskDue } from '../../../src/fileBackup/scheduler/isFileBackupTaskDue.js';
import type { FileBackupRun, FileBackupTask } from '../../../src/fileBackup/types.js';

function makeTask(overrides: Partial<FileBackupTask> = {}): FileBackupTask {
  return {
    id: 't1',
    clientId: 'c1',
    repositoryId: 'r1',
    name: 'task',
    sourceKind: 'local_folder',
    sourcePath: 'D:\\Sites\\acme\\uploads',
    transportId: null,
    remoteSourcePath: null,
    retentionCount: null,
    retentionDays: null,
    scheduleTime: '03:00',
    scheduleEnabled: true,
    scheduleFrequency: 'daily',
    scheduleDaysOfWeek: null,
    scheduleDayOfMonth: null,
    isActive: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeRun(startedAt: string): FileBackupRun {
  return {
    id: 'run1',
    taskId: 't1',
    clientId: 'c1',
    repositoryId: 'r1',
    status: 'Success',
    snapshotId: 'snap1',
    filesNew: 0,
    filesChanged: 0,
    filesUnmodified: 0,
    filesDeleted: 0,
    dirsNew: 0,
    dirsChanged: 0,
    totalFilesProcessed: 0,
    totalBytesProcessed: 0,
    dataAdded: 0,
    dataAddedPacked: 0,
    startedAt,
    finishedAt: startedAt,
    durationMs: 1,
    errorMessage: null,
    errorStack: null,
    warnings: null,
    logFilePath: null,
    pid: 1,
    createdAt: startedAt,
  };
}

describe('isFileBackupTaskDue', () => {
  it('is not due when scheduling is disabled, no schedule time, or the task is inactive', () => {
    expect(isFileBackupTaskDue(makeTask({ scheduleEnabled: false }), new Date(2026, 0, 1, 10, 0), null)).toBe(false);
    expect(isFileBackupTaskDue(makeTask({ scheduleTime: null }), new Date(2026, 0, 1, 10, 0), null)).toBe(false);
    expect(isFileBackupTaskDue(makeTask({ isActive: false }), new Date(2026, 0, 1, 10, 0), null)).toBe(false);
  });

  it('is due at/after the scheduled time with no prior run today, not before', () => {
    const task = makeTask({ scheduleTime: '03:00' });
    expect(isFileBackupTaskDue(task, new Date(2026, 0, 1, 2, 59), null)).toBe(false);
    expect(isFileBackupTaskDue(task, new Date(2026, 0, 1, 3, 0), null)).toBe(true);
  });

  it('is not due again the same day, but is due the next day', () => {
    const task = makeTask({ scheduleTime: '03:00' });
    const runToday = makeRun(new Date(2026, 0, 1, 3, 0).toISOString());
    expect(isFileBackupTaskDue(task, new Date(2026, 0, 1, 9, 0), runToday)).toBe(false);

    const runYesterday = makeRun(new Date(2025, 11, 31, 3, 0).toISOString());
    expect(isFileBackupTaskDue(task, new Date(2026, 0, 1, 9, 0), runYesterday)).toBe(true);
  });

  it('weekly: due only on a configured day of the week', () => {
    // 2026-01-01 is a Thursday (day 4).
    expect(isFileBackupTaskDue(makeTask({ scheduleFrequency: 'weekly', scheduleDaysOfWeek: [4] }), new Date(2026, 0, 1, 9, 0), null)).toBe(true);
    expect(isFileBackupTaskDue(makeTask({ scheduleFrequency: 'weekly', scheduleDaysOfWeek: [1] }), new Date(2026, 0, 1, 9, 0), null)).toBe(false);
    expect(isFileBackupTaskDue(makeTask({ scheduleFrequency: 'weekly', scheduleDaysOfWeek: null }), new Date(2026, 0, 1, 9, 0), null)).toBe(false);
  });

  it('monthly: due on the configured day, clamped to the month\'s length', () => {
    expect(isFileBackupTaskDue(makeTask({ scheduleFrequency: 'monthly', scheduleDayOfMonth: 15 }), new Date(2026, 0, 15, 9, 0), null)).toBe(true);
    // April 2026 has 30 days — day 31 clamps to the 30th.
    expect(isFileBackupTaskDue(makeTask({ scheduleFrequency: 'monthly', scheduleDayOfMonth: 31 }), new Date(2026, 3, 30, 9, 0), null)).toBe(true);
    expect(isFileBackupTaskDue(makeTask({ scheduleFrequency: 'monthly', scheduleDayOfMonth: null }), new Date(2026, 0, 15, 9, 0), null)).toBe(false);
  });
});
