import { getApiBase } from './apiBase';

export interface PocketStatus {
  configured: boolean;
  enabled: boolean;
  driveConnected: boolean;
  driveRemotePath: string | null;
  dirty: boolean;
  lastAttemptedRevision: number | null;
  lastConfirmedRevision: number | null;
  lastAttemptAt: string | null;
  lastSuccessfulPublishAt: string | null;
  lastError: string | null;
  deviceLabel: string | null;
  pairedAt: string | null;
  revokedAt: string | null;
  vaultUnlocked: boolean;
}

export interface PocketPairingDriveHint {
  fileId: string | null;
  remotePath: string;
  fileName: string;
}

export interface PocketPairingPayload {
  v: 1;
  pocketId: string;
  dek: string;
  drive: PocketPairingDriveHint;
}

export interface PocketPublishResult {
  status: 'published' | 'skipped_not_dirty' | 'not_configured' | 'disabled' | 'failed';
  revision?: number;
  error?: string;
}

async function handleJson<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok && res.status !== 502) {
    const err = new Error(body.error ?? `Request failed: ${res.status}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return body as T;
}

function post(path: string, body?: unknown): Promise<Response> {
  return fetch(`${getApiBase()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export async function fetchPocketStatus(): Promise<PocketStatus> {
  return handleJson(await fetch(`${getApiBase()}/pocket/status`));
}

export async function configurePocket(driveRemotePath: string): Promise<PocketStatus> {
  return handleJson(await post('/pocket/configure', { driveRemotePath }));
}

export async function setPocketEnabled(enabled: boolean): Promise<PocketStatus> {
  return handleJson(await post(enabled ? '/pocket/enable' : '/pocket/disable'));
}

export async function connectPocketDrive(token: string): Promise<PocketStatus> {
  return handleJson(await post('/pocket/drive/connect', { token }));
}

export async function reusePocketDrive(source: 'vault-backup' | 'replication', id: string): Promise<PocketStatus> {
  return handleJson(await post('/pocket/drive/connect', { reuse: { source, id } }));
}

export async function disconnectPocketDrive(): Promise<PocketStatus> {
  return handleJson(await post('/pocket/drive/disconnect'));
}

export async function testPocketDrive(): Promise<{ ok: boolean; detail?: string; error?: string }> {
  const res = await post('/pocket/drive/test');
  return handleJson(res);
}

export async function generatePocketPairing(deviceLabel?: string): Promise<{ payload: PocketPairingPayload; status: PocketStatus }> {
  return handleJson(await post('/pocket/pairing', { deviceLabel }));
}

export async function publishPocketNow(force = false): Promise<PocketPublishResult & { pocketStatus: PocketStatus }> {
  const res = await post('/pocket/publish', { force });
  const body = await res.json().catch(() => ({}));
  return body as PocketPublishResult & { pocketStatus: PocketStatus };
}

export async function revokePocketDevice(): Promise<PocketStatus> {
  return handleJson(await post('/pocket/revoke'));
}
