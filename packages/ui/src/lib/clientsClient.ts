import type { Client } from 'engine-core';

// Dev-time only: talks to `engine-cli serve` directly over HTTP — see statusClient.ts.
const BASE_URL = 'http://127.0.0.1:4287';

export interface ClientWithTaskCount extends Client {
  taskCount: number;
}

export interface ClientInput {
  name: string;
  description?: string | null;
  localBasePath: string;
  retentionCount?: number | null;
  retentionDays?: number | null;
}

async function handleJson<T>(res: Response): Promise<T> {
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `Request failed: ${res.status}`);
  return body;
}

export async function fetchClients(opts: { includeInactive?: boolean } = {}): Promise<ClientWithTaskCount[]> {
  const query = opts.includeInactive ? '?includeInactive=true' : '';
  return handleJson(await fetch(`${BASE_URL}/clients${query}`));
}

export async function createClient(input: ClientInput): Promise<Client> {
  return handleJson(
    await fetch(`${BASE_URL}/clients`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
  );
}

export async function updateClient(id: string, patch: Partial<ClientInput>): Promise<Client> {
  return handleJson(
    await fetch(`${BASE_URL}/clients/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
  );
}

export async function deactivateClient(id: string): Promise<void> {
  await handleJson(await fetch(`${BASE_URL}/clients/${id}/deactivate`, { method: 'POST' }));
}

export async function reactivateClient(id: string): Promise<void> {
  await handleJson(await fetch(`${BASE_URL}/clients/${id}/reactivate`, { method: 'POST' }));
}

export type { Client };
