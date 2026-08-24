import type { LogEvent, LogEventLevel } from 'engine-core';

// Dev-time only: talks to `engine-cli serve` directly over HTTP — see statusClient.ts.
const BASE_URL = 'http://127.0.0.1:4287';

export interface LogEventRow extends LogEvent {
  clientName: string | null;
  taskName: string | null;
}

export interface LogsResult {
  events: LogEventRow[];
  total: number;
  steps: string[];
}

export interface FetchLogsOptions {
  search?: string;
  step?: string;
  level?: LogEventLevel;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export async function fetchLogs(opts: FetchLogsOptions = {}): Promise<LogsResult> {
  const params = new URLSearchParams();
  if (opts.search) params.set('search', opts.search);
  if (opts.step) params.set('step', opts.step);
  if (opts.level) params.set('level', opts.level);
  if (opts.from) params.set('from', opts.from);
  if (opts.to) params.set('to', opts.to);
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.offset) params.set('offset', String(opts.offset));
  const query = params.toString();
  const res = await fetch(`${BASE_URL}/logs${query ? `?${query}` : ''}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  return res.json();
}
