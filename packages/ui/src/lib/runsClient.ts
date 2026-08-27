import type { BackupRun } from 'engine-core';
import { getApiBase } from './apiBase';

export interface RunRow extends BackupRun {
  clientName: string | null;
  taskName: string | null;
  backupSetName: string | null;
  /** Whether localPath still points at a real file — a manually-deleted or retention-pruned run keeps its DB row/localPath, so this is the real signal for whether download/delete are still meaningful, not just `localPath` being set. Only populated by GET /runs (Historial); GET /backups already excludes such rows entirely. */
  localFileExists?: boolean;
}

export async function fetchRuns(opts: { taskId?: string; clientId?: string; limit?: number } = {}): Promise<RunRow[]> {
  const params = new URLSearchParams();
  if (opts.taskId) params.set('taskId', opts.taskId);
  if (opts.clientId) params.set('clientId', opts.clientId);
  if (opts.limit) params.set('limit', String(opts.limit));
  const query = params.toString();
  const res = await fetch(`${getApiBase()}/runs${query ? `?${query}` : ''}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  return res.json();
}

/** A direct download link — the file streams from the server, so this is used as a plain <a href>, never fetched via JS (a multi-GB dump has no business going through a JS Blob). */
export function downloadRunUrl(runId: string): string {
  return `${getApiBase()}/runs/${runId}/download`;
}

/** Permanently deletes the backup's file on disk (manual, not automated retention) — the run row/history is untouched. Always confirm with the user first; this can't be undone. */
export async function deleteBackupRun(runId: string): Promise<void> {
  const res = await fetch(`${getApiBase()}/runs/${runId}/delete`, { method: 'POST' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
}

export interface BackupsPage {
  runs: RunRow[];
  total: number;
}

/** Real backups only (Success/Warning runs with a file on disk) — distinct from fetchRuns' every-attempt Historial view. Paginated. */
export async function fetchBackups(
  opts: { clientId?: string; taskId?: string; limit?: number; offset?: number } = {}
): Promise<BackupsPage> {
  const params = new URLSearchParams();
  if (opts.clientId) params.set('clientId', opts.clientId);
  if (opts.taskId) params.set('taskId', opts.taskId);
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.offset) params.set('offset', String(opts.offset));
  const query = params.toString();
  const res = await fetch(`${getApiBase()}/backups${query ? `?${query}` : ''}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  return res.json();
}
