import { describe, expect, it } from 'vitest';
import { nextScheduledRunAt, type ScheduleShape } from '../../src/scheduler/nextOccurrence.js';

const base: ScheduleShape = {
  scheduleEnabled: true,
  scheduleTime: '03:00',
  scheduleFrequency: 'daily',
  scheduleDaysOfWeek: null,
  scheduleDayOfMonth: null,
};

// A fixed "now": Wednesday 2026-09-09, 10:00 local.
const NOW = new Date(2026, 8, 9, 10, 0, 0, 0);

describe('nextScheduledRunAt', () => {
  it('returns null when the schedule is disabled or has no time', () => {
    expect(nextScheduledRunAt({ ...base, scheduleEnabled: false }, NOW, false)).toBeNull();
    expect(nextScheduledRunAt({ ...base, scheduleTime: null }, NOW, false)).toBeNull();
  });

  it('daily: today\'s slot is behind us at 10:00 → next is tomorrow 03:00', () => {
    const next = nextScheduledRunAt(base, NOW, false)!;
    expect(next.getFullYear()).toBe(2026);
    expect(next.getMonth()).toBe(8);
    expect(next.getDate()).toBe(10); // tomorrow
    expect(next.getHours()).toBe(3);
    expect(next.getMinutes()).toBe(0);
  });

  it('daily: today\'s slot still ahead → next is today', () => {
    const morning = new Date(2026, 8, 9, 1, 30, 0, 0); // 01:30, before 03:00
    const next = nextScheduledRunAt(base, morning, false)!;
    expect(next.getDate()).toBe(9);
    expect(next.getHours()).toBe(3);
  });

  it('daily: today\'s slot ahead but it already ran today (scheduled) → next is tomorrow', () => {
    const morning = new Date(2026, 8, 9, 1, 30, 0, 0);
    const next = nextScheduledRunAt(base, morning, true)!;
    expect(next.getDate()).toBe(10);
  });

  it('weekly: picks the next configured weekday', () => {
    // NOW is Wednesday (getDay()===3). Schedule Mon(1)/Fri(5).
    const weekly: ScheduleShape = { ...base, scheduleFrequency: 'weekly', scheduleDaysOfWeek: [1, 5] };
    const next = nextScheduledRunAt(weekly, NOW, false)!;
    expect(next.getDay()).toBe(5); // this coming Friday
    expect(next.getDate()).toBe(11);
  });

  it('weekly: today IS a configured day and the slot is still ahead → today', () => {
    const weekly: ScheduleShape = { ...base, scheduleFrequency: 'weekly', scheduleDaysOfWeek: [3] };
    const morning = new Date(2026, 8, 9, 1, 0, 0, 0); // Wed 01:00
    const next = nextScheduledRunAt(weekly, morning, false)!;
    expect(next.getDate()).toBe(9);
  });

  it('weekly with no days configured → null', () => {
    expect(nextScheduledRunAt({ ...base, scheduleFrequency: 'weekly', scheduleDaysOfWeek: [] }, NOW, false)).toBeNull();
    expect(nextScheduledRunAt({ ...base, scheduleFrequency: 'weekly', scheduleDaysOfWeek: null }, NOW, false)).toBeNull();
  });

  it('monthly: next occurrence of the configured day-of-month', () => {
    const monthly: ScheduleShape = { ...base, scheduleFrequency: 'monthly', scheduleDayOfMonth: 15 };
    const next = nextScheduledRunAt(monthly, NOW, false)!;
    expect(next.getMonth()).toBe(8); // September
    expect(next.getDate()).toBe(15);
  });

  it('monthly: day 31 clamps to the last day of a short month (Sep = 30)', () => {
    const monthly: ScheduleShape = { ...base, scheduleFrequency: 'monthly', scheduleDayOfMonth: 31 };
    const next = nextScheduledRunAt(monthly, NOW, false)!;
    expect(next.getMonth()).toBe(8);
    expect(next.getDate()).toBe(30);
  });

  it('monthly: after this month\'s day has passed → next month', () => {
    const monthly: ScheduleShape = { ...base, scheduleFrequency: 'monthly', scheduleDayOfMonth: 5 };
    const next = nextScheduledRunAt(monthly, NOW, false)!; // NOW is the 9th
    expect(next.getMonth()).toBe(9); // October
    expect(next.getDate()).toBe(5);
  });

  it('monthly with no day configured → null', () => {
    expect(nextScheduledRunAt({ ...base, scheduleFrequency: 'monthly', scheduleDayOfMonth: null }, NOW, false)).toBeNull();
  });

  it('malformed scheduleTime → null (defensive)', () => {
    expect(nextScheduledRunAt({ ...base, scheduleTime: 'nope' }, NOW, false)).toBeNull();
  });
});
