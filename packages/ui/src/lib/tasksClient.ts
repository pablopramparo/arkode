import type { BackupTask, BackupStrategyKind, DbEngine, ScheduleFrequency, DirectDumpCompatibilityResult } from 'engine-core';
import { getApiBase } from './apiBase';

export interface TaskRow extends BackupTask {
  clientName: string;
  transportName: string | null;
  databaseConnectionName: string | null;
}

export interface TaskInput {
  clientId: string;
  name: string;
  strategy: BackupStrategyKind;
  transportId?: string;
  databaseConnectionId?: string;
  dbEngine?: DbEngine;
  retentionCount?: number | null;
  retentionDays?: number | null;
  scheduleTime?: string | null;
  scheduleEnabled?: boolean;
  scheduleFrequency?: ScheduleFrequency;
  scheduleDaysOfWeek?: number[] | null;
  scheduleDayOfMonth?: number | null;
  /** Skip the direct_dump compatibility gate and apply the schedule anyway — see ScheduleCompatibilityError. */
  force?: boolean;
}

/** A BackupTask as returned right after creation — `scheduleBlocked` is set only when a requested schedule couldn't be applied because the direct_dump compatibility gate failed (the task itself was still created). */
export type CreatedTask = BackupTask & { scheduleBlocked?: DirectDumpCompatibilityResult };

/**
 * Thrown by setTaskSchedule when the server refuses to enable a direct_dump
 * task's schedule because the compatibility gate (connection + detected
 * server version + a usable local dump tool) failed — distinct from a
 * request-level error. Callers can offer the user a "force anyway" retry
 * using `compatibility` for context, by re-calling with `force: true`.
 */
export class ScheduleCompatibilityError extends Error {
  compatibility: DirectDumpCompatibilityResult;
  constructor(compatibility: DirectDumpCompatibilityResult) {
    super(compatibility.message);
    this.compatibility = compatibility;
  }
}

export interface TaskUpdateInput {
  name?: string;
  retentionCount?: number | null;
  retentionDays?: number | null;
}

async function handleJson<T>(res: Response): Promise<T> {
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `Request failed: ${res.status}`);
  return body;
}

export async function fetchTasks(opts: { includeInactive?: boolean } = {}): Promise<TaskRow[]> {
  const query = opts.includeInactive ? '?includeInactive=true' : '';
  return handleJson(await fetch(`${getApiBase()}/tasks${query}`));
}

export async function createTask(input: TaskInput): Promise<CreatedTask> {
  return handleJson(
    await fetch(`${getApiBase()}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
  );
}

export async function updateTask(id: string, patch: TaskUpdateInput): Promise<BackupTask> {
  return handleJson(
    await fetch(`${getApiBase()}/tasks/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
  );
}

export interface SetTaskScheduleInput {
  scheduleTime: string | null;
  scheduleEnabled: boolean;
  scheduleFrequency?: ScheduleFrequency;
  scheduleDaysOfWeek?: number[] | null;
  scheduleDayOfMonth?: number | null;
  /** Skip the direct_dump compatibility gate and apply the schedule anyway. */
  force?: boolean;
}

export async function setTaskSchedule(id: string, input: SetTaskScheduleInput): Promise<BackupTask> {
  const res = await fetch(`${getApiBase()}/tasks/${id}/schedule`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await res.json();
  if (res.status === 409 && body.compatibility) {
    throw new ScheduleCompatibilityError(body.compatibility);
  }
  if (!res.ok) throw new Error(body.error ?? `Request failed: ${res.status}`);
  return body;
}

export async function deactivateTask(id: string): Promise<void> {
  await handleJson(await fetch(`${getApiBase()}/tasks/${id}/deactivate`, { method: 'POST' }));
}

export async function reactivateTask(id: string): Promise<void> {
  await handleJson(await fetch(`${getApiBase()}/tasks/${id}/reactivate`, { method: 'POST' }));
}
