import type { Client } from 'engine-core';
import { getApiBase } from './apiBase';

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
  return handleJson(await fetch(`${getApiBase()}/clients${query}`));
}

export async function createClient(input: ClientInput): Promise<Client> {
  return handleJson(
    await fetch(`${getApiBase()}/clients`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
  );
}

export async function updateClient(id: string, patch: Partial<ClientInput>): Promise<Client> {
  return handleJson(
    await fetch(`${getApiBase()}/clients/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
  );
}

export async function deactivateClient(id: string): Promise<void> {
  await handleJson(await fetch(`${getApiBase()}/clients/${id}/deactivate`, { method: 'POST' }));
}

export async function reactivateClient(id: string): Promise<void> {
  await handleJson(await fetch(`${getApiBase()}/clients/${id}/reactivate`, { method: 'POST' }));
}

export type { Client };
