import type { BackupTask, BackupRunStatus, BackupStrategyKind, DbEngine, ScheduleFrequency, DirectDumpCompatibilityResult } from 'engine-core';
import { getApiBase } from './apiBase';

/** True while a run is genuinely in progress — matches runsRepo.ts's own listInProgress query, which is what runBackupTask.ts's app-level lock is built on. */
export const IN_PROGRESS_RUN_STATUSES: BackupRunStatus[] = ['Running', 'Producing', 'Validating'];

export interface TaskRow extends BackupTask {
  clientName: string;
  transportName: string | null;
  databaseConnectionName: string | null;
  /** The task's latest attempt, whatever it is — null if it's never run. Lets the UI disable/relabel "Ejecutar ahora" while a run is genuinely in progress, without its own polling. */
  latestRunStatus: BackupRunStatus | null;
  /** Pure visual/reporting label, or null if unassigned — see engine-core's BackupSet doc comment. */
  backupSetName: string | null;
}

export interface TaskInput {
  clientId: string;
  name: string;
  strategy: BackupStrategyKind;
  transportId?: string;
  databaseConnectionId?: string;
  dbEngine?: DbEngine;
  /** fetch_existing only. */
  remotePath?: string;
  remoteFilePattern?: string | null;
  /** remote_dump only. */
  remoteCommand?: string;
  remoteOutputPathTemplate?: string;
  remoteCleanup?: boolean;
  retentionCount?: number | null;
  retentionDays?: number | null;
  scheduleTime?: string | null;
  scheduleEnabled?: boolean;
  scheduleFrequency?: ScheduleFrequency;
  scheduleDaysOfWeek?: number[] | null;
  scheduleDayOfMonth?: number | null;
  /** Skip the direct_dump compatibility gate and apply the schedule anyway — see ScheduleCompatibilityError. */
  force?: boolean;
  /** Optional — a pure visual/reporting label grouping this task with others. */
  backupSetId?: string | null;
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
  /** Assign/reassign/unassign (pass null) — unlike strategy/transport/etc., this is editable after creation. */
  backupSetId?: string | null;
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

/** A function, not a precomputed constant — see apiBase.ts's own note on why (must read the base URL fresh at call time, not at import time). */
export function taskExportUrl(taskId: string): string {
  return `${getApiBase()}/tasks/${taskId}/export`;
}

export interface ImportedTaskBundleResult {
  taskId: string | null;
  transportCreated: boolean;
  databaseConnectionCreated: boolean;
  secretsNeedingReentry: string[];
  errors: string[];
}

/** Attaches an exported task+connection (see taskExportUrl) to an existing client — unlike config import, this never creates a new client. `bundle` is the parsed JSON from a task:export file. */
export async function importTaskBundle(clientId: string, bundle: unknown): Promise<ImportedTaskBundleResult> {
  const res = await fetch(`${getApiBase()}/tasks/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId, bundle }),
  });
  const body = await res.json();
  if (res.status >= 500) throw new Error(body.error ?? `Request failed: ${res.status}`);
  return body;
}
