import type { BackupTask, BackupStrategyKind, DbEngine } from 'engine-core';

// Dev-time only: talks to `engine-cli serve` directly over HTTP — see statusClient.ts.
const BASE_URL = 'http://127.0.0.1:4287';

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
  return handleJson(await fetch(`${BASE_URL}/tasks${query}`));
}

export async function createTask(input: TaskInput): Promise<BackupTask> {
  return handleJson(
    await fetch(`${BASE_URL}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
  );
}

export async function updateTask(id: string, patch: TaskUpdateInput): Promise<BackupTask> {
  return handleJson(
    await fetch(`${BASE_URL}/tasks/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
  );
}

export async function setTaskSchedule(id: string, scheduleTime: string | null, scheduleEnabled: boolean): Promise<BackupTask> {
  return handleJson(
    await fetch(`${BASE_URL}/tasks/${id}/schedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scheduleTime, scheduleEnabled }),
    })
  );
}

export async function deactivateTask(id: string): Promise<void> {
  await handleJson(await fetch(`${BASE_URL}/tasks/${id}/deactivate`, { method: 'POST' }));
}

export async function reactivateTask(id: string): Promise<void> {
  await handleJson(await fetch(`${BASE_URL}/tasks/${id}/reactivate`, { method: 'POST' }));
}
