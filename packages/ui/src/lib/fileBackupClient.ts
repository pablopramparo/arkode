import type { ConnectionTestResult } from 'engine-core';
import { getApiBase } from './apiBase';
import type { FetchLogsOptions, LogsResult } from './logsClient';

// Mirrors engine-core's fileBackup/types.ts shapes (camelCase JSON over the
// wire) — no import from 'engine-core' here since the file-backup domain
// isn't re-exported the same way the DB-backup types are wired into the UI
// yet; kept as plain local interfaces, consistent with how small this
// client is meant to stay for a first "mínima" increment.

export type FileBackupRunStatus = 'Pending' | 'Running' | 'Producing' | 'Validating' | 'Success' | 'Warning' | 'Failed';

export interface FileBackupRepository {
  id: string;
  clientId: string;
  repoPath: string;
  resticRepoId: string | null;
  lastPrunedAt: string | null;
  lastCheckedAt: string | null;
  initializedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FileBackupTask {
  id: string;
  clientId: string;
  repositoryId: string;
  name: string;
  sourceKind: 'local_folder' | 'remote_folder';
  /** local_folder only. */
  sourcePath: string | null;
  /** remote_folder only. */
  transportId: string | null;
  /** remote_folder only. */
  remoteSourcePath: string | null;
  retentionCount: number | null;
  retentionDays: number | null;
  scheduleTime: string | null;
  scheduleEnabled: boolean;
  scheduleFrequency: 'daily' | 'weekly' | 'monthly';
  scheduleDaysOfWeek: number[] | null;
  scheduleDayOfMonth: number | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface FileBackupRun {
  id: string;
  taskId: string;
  clientId: string;
  repositoryId: string;
  status: FileBackupRunStatus;
  snapshotId: string | null;
  filesNew: number | null;
  filesChanged: number | null;
  filesUnmodified: number | null;
  filesDeleted: number | null;
  totalFilesProcessed: number | null;
  totalBytesProcessed: number | null;
  dataAdded: number | null;
  dataAddedPacked: number | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  errorMessage: string | null;
  warnings: string[] | null;
}

async function handleJson<T>(res: Response): Promise<T> {
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `Request failed: ${res.status}`);
  return body;
}

export async function fetchFileBackupRepository(clientId: string): Promise<FileBackupRepository | null> {
  const repos = await handleJson<FileBackupRepository[]>(await fetch(`${getApiBase()}/file-repos?client=${clientId}`));
  return repos[0] ?? null;
}

export async function createFileBackupRepository(clientId: string): Promise<FileBackupRepository & { recoveryKey: string }> {
  return handleJson(
    await fetch(`${getApiBase()}/file-repos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId }),
    })
  );
}

export async function exportFileBackupRepositoryKey(repositoryId: string): Promise<string> {
  const { recoveryKey } = await handleJson<{ recoveryKey: string }>(
    await fetch(`${getApiBase()}/file-repos/${repositoryId}/export-key`)
  );
  return recoveryKey;
}

export async function runFileBackupMaintenance(repositoryId: string, operation?: 'prune' | 'check' | 'check-read-data' | 'all'): Promise<unknown> {
  return handleJson(
    await fetch(`${getApiBase()}/file-repos/${repositoryId}/run-maintenance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation }),
    })
  );
}

export async function fetchFileBackupTasks(clientId: string, opts: { includeInactive?: boolean } = {}): Promise<FileBackupTask[]> {
  const query = new URLSearchParams({ client: clientId });
  if (opts.includeInactive) query.set('includeInactive', 'true');
  return handleJson(await fetch(`${getApiBase()}/file-tasks?${query}`));
}

export interface CreateFileBackupTaskInput {
  clientId: string;
  name: string;
  sourceKind?: 'local_folder' | 'remote_folder';
  /** Required for local_folder. */
  sourcePath?: string;
  /** Required for remote_folder. */
  transportId?: string;
  /** Required for remote_folder. */
  remoteSourcePath?: string;
  retentionCount?: number | null;
  retentionDays?: number | null;
}

export async function createFileBackupTask(input: CreateFileBackupTaskInput): Promise<FileBackupTask> {
  return handleJson(
    await fetch(`${getApiBase()}/file-tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
  );
}

export async function deactivateFileBackupTask(id: string): Promise<void> {
  await handleJson(await fetch(`${getApiBase()}/file-tasks/${id}/deactivate`, { method: 'POST' }));
}

export async function reactivateFileBackupTask(id: string): Promise<void> {
  await handleJson(await fetch(`${getApiBase()}/file-tasks/${id}/reactivate`, { method: 'POST' }));
}

export async function runFileBackupTaskNow(id: string): Promise<FileBackupRun> {
  return handleJson(await fetch(`${getApiBase()}/file-tasks/${id}/run`, { method: 'POST' }));
}

/** remote_folder only. trustHost: true retries an unknown-host rejection as an explicit "yes, trust this host" — only ever call it after the person has seen the presented fingerprint and confirmed it. */
export async function testFileBackupTaskConnection(id: string, trustHost?: boolean): Promise<ConnectionTestResult> {
  const res = await fetch(`${getApiBase()}/file-tasks/${id}/test-connection`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trustHost: Boolean(trustHost) }),
  });
  const body = await res.json();
  if (res.status === 404 || res.status === 500) throw new Error(body.error ?? `Request failed: ${res.status}`);
  return body;
}

export interface SetFileBackupScheduleInput {
  scheduleTime: string | null;
  scheduleEnabled: boolean;
  scheduleFrequency?: 'daily' | 'weekly' | 'monthly';
  scheduleDaysOfWeek?: number[] | null;
  scheduleDayOfMonth?: number | null;
  disable?: boolean;
}

export async function setFileBackupTaskSchedule(id: string, input: SetFileBackupScheduleInput): Promise<FileBackupTask> {
  return handleJson(
    await fetch(`${getApiBase()}/file-tasks/${id}/schedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
  );
}

export async function fetchFileBackupRuns(opts: { taskId?: string; clientId?: string; limit?: number } = {}): Promise<FileBackupRun[]> {
  const query = new URLSearchParams();
  if (opts.taskId) query.set('task', opts.taskId);
  if (opts.clientId) query.set('client', opts.clientId);
  if (opts.limit) query.set('limit', String(opts.limit));
  return handleJson(await fetch(`${getApiBase()}/file-runs?${query}`));
}

export async function restoreFileBackupRun(runId: string, targetDir: string): Promise<{ filesRestored: number; warning?: string; targetDir: string }> {
  return handleJson(
    await fetch(`${getApiBase()}/file-runs/${runId}/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetDir }),
    })
  );
}

/** A function, not a precomputed constant — see apiBase.ts's own note on why. */
export function fileBackupDownloadFileUrl(runId: string, absoluteSourcePath: string): string {
  return `${getApiBase()}/file-runs/${runId}/download-file?path=${encodeURIComponent(absoluteSourcePath)}`;
}

/** Same response shape as logsClient.ts's fetchLogs (see /file-logs, which mirrors /logs exactly) — reuses its types rather than duplicating them. */
export async function fetchFileLogs(opts: FetchLogsOptions = {}): Promise<LogsResult> {
  const params = new URLSearchParams();
  if (opts.search) params.set('search', opts.search);
  if (opts.step) params.set('step', opts.step);
  if (opts.level) params.set('level', opts.level);
  if (opts.from) params.set('from', opts.from);
  if (opts.to) params.set('to', opts.to);
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.offset) params.set('offset', String(opts.offset));
  const query = params.toString();
  const res = await fetch(`${getApiBase()}/file-logs${query ? `?${query}` : ''}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  return res.json();
}
