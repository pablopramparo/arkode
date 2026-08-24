import type { ImportConfigResult, SystemInfo } from 'engine-core';

// Dev-time only: talks to `engine-cli serve` directly over HTTP — see statusClient.ts.
const BASE_URL = 'http://127.0.0.1:4287';

export const CONFIG_EXPORT_URL = `${BASE_URL}/config/export`;

export async function fetchSystemInfo(): Promise<SystemInfo> {
  const res = await fetch(`${BASE_URL}/system`);
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.json();
}

export async function importConfig(data: unknown): Promise<ImportConfigResult> {
  const res = await fetch(`${BASE_URL}/config/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `Request failed: ${res.status}`);
  return body;
}
