import type { BackupSet } from 'engine-core';
import { getApiBase } from './apiBase';

async function handleJson<T>(res: Response): Promise<T> {
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `Request failed: ${res.status}`);
  return body;
}

export async function fetchBackupSets(clientId: string, opts: { includeInactive?: boolean } = {}): Promise<BackupSet[]> {
  const query = new URLSearchParams({ client: clientId });
  if (opts.includeInactive) query.set('includeInactive', 'true');
  return handleJson(await fetch(`${getApiBase()}/backup-sets?${query}`));
}

export async function createBackupSet(clientId: string, name: string): Promise<BackupSet> {
  return handleJson(
    await fetch(`${getApiBase()}/backup-sets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, name }),
    })
  );
}

export async function updateBackupSet(id: string, name: string): Promise<BackupSet> {
  return handleJson(
    await fetch(`${getApiBase()}/backup-sets/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
  );
}

export async function deactivateBackupSet(id: string): Promise<void> {
  await handleJson(await fetch(`${getApiBase()}/backup-sets/${id}/deactivate`, { method: 'POST' }));
}

export async function reactivateBackupSet(id: string): Promise<void> {
  await handleJson(await fetch(`${getApiBase()}/backup-sets/${id}/reactivate`, { method: 'POST' }));
}
