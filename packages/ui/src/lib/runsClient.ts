import type { BackupRun } from 'engine-core';

// Dev-time only: talks to `engine-cli serve` directly over HTTP — see statusClient.ts.
const BASE_URL = 'http://127.0.0.1:4287';

export interface RunRow extends BackupRun {
  clientName: string | null;
  taskName: string | null;
}

export async function fetchRuns(opts: { taskId?: string; clientId?: string; limit?: number } = {}): Promise<RunRow[]> {
  const params = new URLSearchParams();
  if (opts.taskId) params.set('taskId', opts.taskId);
  if (opts.clientId) params.set('clientId', opts.clientId);
  if (opts.limit) params.set('limit', String(opts.limit));
  const query = params.toString();
  const res = await fetch(`${BASE_URL}/runs${query ? `?${query}` : ''}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  return res.json();
}

/** A direct download link — the file streams from the server, so this is used as a plain <a href>, never fetched via JS (a multi-GB dump has no business going through a JS Blob). */
export function downloadRunUrl(runId: string): string {
  return `${BASE_URL}/runs/${runId}/download`;
}
