import { isTauri, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getApiBase } from './apiBase';

export type ReplicationContent = 'restic_repo' | 'db_dumps';
export type ReplicationLastStatus = 'Success' | 'Warning' | 'Failed';

export interface ReplicationTarget {
  id: string;
  clientId: string;
  content: ReplicationContent;
  provider: 'rclone_drive';
  remotePath: string;
  encryptWithCrypt: boolean;
  enabled: boolean;
  lastReplicatedAt: string | null;
  lastStatus: ReplicationLastStatus | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  /** Enriched by GET /replication-targets. */
  clientName?: string | null;
  authorized?: boolean;
  due?: boolean;
  /** Only present in the POST /replication-targets response, once. */
  generatedCryptPassword?: string | null;
}

export interface ReplicationRun {
  id: string;
  targetId: string;
  clientId: string;
  trigger: 'manual' | 'scheduled';
  status: 'Running' | 'Success' | 'Warning' | 'Failed';
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  bytesTransferred: number | null;
  filesTransferred: number | null;
  filesDeleted: number | null;
  errorMessage: string | null;
}

async function handleJson<T>(res: Response): Promise<T> {
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `Request failed: ${res.status}`);
  return body as T;
}

export async function fetchReplicationTargets(clientId: string): Promise<ReplicationTarget[]> {
  return handleJson(await fetch(`${getApiBase()}/replication-targets?client=${encodeURIComponent(clientId)}`));
}

export async function createReplicationTarget(input: {
  clientId: string;
  content: ReplicationContent;
  remotePath: string;
  encrypt?: boolean;
}): Promise<ReplicationTarget> {
  return handleJson(
    await fetch(`${getApiBase()}/replication-targets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
  );
}

export async function updateReplicationTarget(
  id: string,
  patch: { enabled?: boolean; remotePath?: string }
): Promise<ReplicationTarget> {
  return handleJson(
    await fetch(`${getApiBase()}/replication-targets/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
  );
}

export async function removeReplicationTarget(id: string): Promise<void> {
  await handleJson(await fetch(`${getApiBase()}/replication-targets/${id}/remove`, { method: 'POST' }));
}

/** Stores a Google OAuth token (from the Tauri authorize flow or pasted from `rclone authorize "drive"`). */
export async function authorizeReplicationTarget(id: string, token: string): Promise<void> {
  await handleJson(
    await fetch(`${getApiBase()}/replication-targets/${id}/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
  );
}

export interface ReplicationTestResult {
  ok: boolean;
  detail?: string;
  error?: string;
}

export async function testReplicationTarget(id: string): Promise<ReplicationTestResult> {
  const res = await fetch(`${getApiBase()}/replication-targets/${id}/test`, { method: 'POST' });
  const body = await res.json();
  if (res.status === 502) return { ok: false, error: body.error };
  if (!res.ok) throw new Error(body.error ?? `Request failed: ${res.status}`);
  return body as ReplicationTestResult;
}

export interface ReplicationRunResult {
  ran: boolean;
  status: 'Success' | 'Warning' | 'Failed' | 'Skipped';
  message?: string;
  bytesTransferred?: number;
  filesTransferred?: number;
}

export async function runReplicationTarget(id: string): Promise<ReplicationRunResult> {
  const res = await fetch(`${getApiBase()}/replication-targets/${id}/run`, { method: 'POST' });
  const body = await res.json();
  if (!res.ok && res.status !== 502) throw new Error(body.error ?? `Request failed: ${res.status}`);
  return body as ReplicationRunResult;
}

export async function fetchReplicationTargetCryptPassword(id: string): Promise<string | null> {
  const body = await handleJson<{ cryptPassword: string | null }>(
    await fetch(`${getApiBase()}/replication-targets/${id}/crypt-password`)
  );
  return body.cryptPassword;
}

export async function pullReplicationTarget(id: string, dest: string): Promise<{ ok: boolean; dest?: string; error?: string }> {
  const res = await fetch(`${getApiBase()}/replication-targets/${id}/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dest }),
  });
  const body = await res.json();
  if (res.status === 502) return { ok: false, error: body.error };
  if (!res.ok) throw new Error(body.error ?? `Request failed: ${res.status}`);
  return body as { ok: boolean; dest?: string };
}

export async function fetchReplicationRuns(targetId: string, limit = 20): Promise<ReplicationRun[]> {
  return handleJson(
    await fetch(`${getApiBase()}/replication-runs?target=${encodeURIComponent(targetId)}&limit=${limit}`)
  );
}

/**
 * Runs `rclone authorize "drive"` via the Tauri shell. Only works inside the
 * desktop app; the caller must offer a paste-token fallback for the
 * plain-browser / headless case.
 */
export function canAuthorizeInApp(): boolean {
  return isTauri();
}

/**
 * @param noOpenBrowser when true, rclone does NOT open a browser — it emits
 * the consent URL via the `rclone-auth-url` event (subscribe with
 * {@link onRcloneAuthUrl}) so the user can copy it into any browser on this
 * PC. Either way the returned promise resolves with the OAuth token once the
 * user finishes approving.
 */
export async function authorizeDriveInApp(opts?: { noOpenBrowser?: boolean }): Promise<string> {
  return invoke<string>('rclone_authorize_drive', { noOpenBrowser: opts?.noOpenBrowser ?? false });
}

/** Subscribe to the consent URL emitted during a `noOpenBrowser` authorize. Returns an unlisten fn. */
export async function onRcloneAuthUrl(cb: (url: string) => void): Promise<() => void> {
  return listen<string>('rclone-auth-url', (e) => cb(e.payload));
}
