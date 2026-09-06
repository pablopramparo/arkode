import type {
  VaultCredential,
  VaultCredentialKind,
  VaultCredentialSecret,
  VaultItem,
  VaultItemMetadata,
  VaultItemType,
  VaultStatus,
  VaultUrl,
} from 'engine-core';
import { getApiBase } from './apiBase';

async function handleJson<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error ?? `Request failed: ${res.status}`) as Error & { status?: number; body?: unknown };
    err.status = res.status;
    err.body = body;
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

// --- Lifecycle ---------------------------------------------------------------
export const VAULT_STATUS_EVENT = 'arkode:vault-status';

/** Notify every mounted component that the vault lock state may have changed. */
export function notifyVaultStatusChanged(): void {
  window.dispatchEvent(new Event(VAULT_STATUS_EVENT));
}

export async function fetchVaultStatus(): Promise<VaultStatus> {
  return handleJson(await fetch(`${getApiBase()}/vault/status`));
}
export async function initVault(password: string): Promise<VaultStatus> {
  const s = await handleJson<VaultStatus>(await post('/vault/init', { password }));
  notifyVaultStatusChanged();
  return s;
}
export async function unlockVault(password: string): Promise<VaultStatus> {
  const s = await handleJson<VaultStatus>(await post('/vault/unlock', { password }));
  notifyVaultStatusChanged();
  return s;
}
export async function lockVault(): Promise<VaultStatus> {
  const s = await handleJson<VaultStatus>(await post('/vault/lock'));
  notifyVaultStatusChanged();
  return s;
}
export async function changeMasterPassword(currentPassword: string, newPassword: string): Promise<VaultStatus> {
  const s = await handleJson<VaultStatus>(await post('/vault/change-password', { currentPassword, newPassword }));
  notifyVaultStatusChanged();
  return s;
}

// --- Credentials -----------------------------------------------------------
export interface CredentialInput {
  clientId?: string;
  name?: string;
  kind?: VaultCredentialKind;
  environment?: string | null;
  tags?: string[];
  host?: string | null;
  port?: number | null;
  username?: string | null;
  databaseName?: string | null;
  url?: string | null;
  favorite?: boolean;
  description?: string | null;
  /** Present = write/replace the encrypted secret. `{}`/null = clear it. Requires the vault unlocked. */
  secret?: VaultCredentialSecret | null;
  /** true = create/refresh a machine-bound operational copy and link it; false = unlink. */
  useForBackups?: boolean;
}

export interface OperationalSyncResult {
  ok: boolean;
  state: string;
  message?: string;
}

export interface CredentialMutationResult {
  credential: VaultCredential;
  operationalSync: OperationalSyncResult;
}

export async function fetchClientCredentials(clientId: string): Promise<VaultCredential[]> {
  return handleJson(await fetch(`${getApiBase()}/clients/${clientId}/credentials`));
}

export interface VaultSearchResult {
  credentials: VaultCredential[];
  urls: VaultUrl[];
  items: VaultItem[];
}

export async function searchVault(query: string, clientId?: string): Promise<VaultSearchResult> {
  const params = new URLSearchParams({ q: query });
  if (clientId) params.set('client', clientId);
  return handleJson(await fetch(`${getApiBase()}/vault/search?${params.toString()}`));
}

// --- URLs -----------------------------------------------------------------
export interface UrlInput {
  clientId?: string;
  name?: string;
  url?: string;
  environment?: string | null;
  tags?: string[];
  linkedCredentialId?: string | null;
  favorite?: boolean;
  description?: string | null;
}
export async function fetchClientUrls(clientId: string): Promise<VaultUrl[]> {
  return handleJson(await fetch(`${getApiBase()}/clients/${clientId}/urls`));
}
export async function createUrl(input: UrlInput): Promise<VaultUrl> {
  return handleJson(await post('/vault/urls', input));
}
export async function updateUrl(id: string, patch: UrlInput): Promise<VaultUrl> {
  return handleJson(
    await fetch(`${getApiBase()}/vault/urls/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
  );
}
export async function deleteUrl(id: string): Promise<void> {
  await handleJson(await fetch(`${getApiBase()}/vault/urls/${id}`, { method: 'DELETE' }));
}

// --- Items (snippet | process | note) -----------------------------------
export interface ItemInput {
  clientId?: string;
  type?: VaultItemType;
  title?: string;
  environment?: string | null;
  tags?: string[];
  description?: string | null;
  favorite?: boolean;
  isSensitive?: boolean;
  body?: string;
  metadata?: VaultItemMetadata;
}
export async function fetchClientItems(clientId: string, type?: VaultItemType): Promise<VaultItem[]> {
  const q = type ? `?type=${type}` : '';
  return handleJson(await fetch(`${getApiBase()}/clients/${clientId}/items${q}`));
}
export async function createItem(input: ItemInput): Promise<VaultItem> {
  return handleJson(await post('/vault/items', input));
}
export async function updateItem(id: string, patch: ItemInput): Promise<VaultItem> {
  return handleJson(
    await fetch(`${getApiBase()}/vault/items/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
  );
}
export async function deleteItem(id: string): Promise<void> {
  await handleJson(await fetch(`${getApiBase()}/vault/items/${id}`, { method: 'DELETE' }));
}
export async function revealItemBody(id: string): Promise<string> {
  const body = await handleJson<{ body: string }>(await post(`/vault/items/${id}/reveal`));
  return body.body;
}

export async function createCredential(input: CredentialInput): Promise<CredentialMutationResult> {
  return handleJson(await post('/vault/credentials', input));
}

export async function updateCredential(id: string, patch: CredentialInput): Promise<CredentialMutationResult> {
  return handleJson(
    await fetch(`${getApiBase()}/vault/credentials/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
  );
}

export async function deleteCredential(id: string): Promise<void> {
  await handleJson(await fetch(`${getApiBase()}/vault/credentials/${id}`, { method: 'DELETE' }));
}

export async function revealCredential(id: string): Promise<VaultCredentialSecret> {
  const body = await handleJson<{ secret: VaultCredentialSecret }>(await post(`/vault/credentials/${id}/reveal`));
  return body.secret;
}

export async function resyncCredential(id: string): Promise<OperationalSyncResult> {
  return handleJson(await post(`/vault/credentials/${id}/resync-operational`));
}

export async function resyncAllOperational(clientId?: string): Promise<{
  results: { credentialId: string; name: string; result: OperationalSyncResult }[];
  allOk: boolean;
}> {
  return handleJson(await post('/vault/resync-operational', clientId ? { client: clientId } : {}));
}

// --- Portable backup (.arkvault) ---------------------------------------
export type VaultBackupTargetKind = 'local_dir' | 'google_drive';
export interface VaultBackupTarget {
  id: string;
  kind: VaultBackupTargetKind;
  /** local_dir only. */
  path: string | null;
  /** google_drive only. */
  remotePath: string | null;
  /** google_drive only — Tier-1 DPAPI ref; the secret is absent until connected. */
  rcloneConfigSecretRef: string | null;
  /** google_drive only — display label (connected account). */
  label: string | null;
  retentionCount: number | null;
  enabled: boolean;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  /** google_drive only — whether an OAuth token is stored. */
  authorized?: boolean;
}
export interface VaultBackupRun {
  id: string;
  targetId: string;
  status: 'Success' | 'Failed';
  filePath: string | null;
  sizeBytes: number | null;
  startedAt: string;
  finishedAt: string | null;
  errorMessage: string | null;
}
export async function fetchVaultBackupTargets(): Promise<VaultBackupTarget[]> {
  return handleJson(await fetch(`${getApiBase()}/vault/backup-targets`));
}
export async function createVaultBackupTarget(input: {
  path: string;
  retentionCount?: number | null;
  enabled?: boolean;
}): Promise<VaultBackupTarget> {
  return handleJson(await post('/vault/backup-targets', input));
}
export async function createVaultBackupDriveTarget(input: {
  remotePath: string;
  label?: string | null;
  retentionCount?: number | null;
  enabled?: boolean;
}): Promise<VaultBackupTarget> {
  return handleJson(await post('/vault/backup-targets', { kind: 'google_drive', ...input }));
}
export async function updateVaultBackupTarget(
  id: string,
  patch: { path?: string; remotePath?: string; label?: string | null; retentionCount?: number | null; enabled?: boolean }
): Promise<VaultBackupTarget> {
  return handleJson(
    await fetch(`${getApiBase()}/vault/backup-targets/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
  );
}
/** Stores a Google OAuth token, or copies one from an already-connected replication target. */
export async function authorizeVaultBackupTarget(
  id: string,
  arg: string | { reuseFromReplicationTargetId: string }
): Promise<void> {
  const body = typeof arg === 'string' ? { token: arg } : arg;
  await handleJson(await post(`/vault/backup-targets/${id}/authorize`, body));
}
export interface VaultBackupTestResult {
  ok: boolean;
  detail?: string;
  error?: string;
}
export async function testVaultBackupTarget(id: string): Promise<VaultBackupTestResult> {
  const res = await post(`/vault/backup-targets/${id}/test`);
  const body = await res.json().catch(() => ({}));
  if (res.status === 502) return { ok: false, error: body.error };
  if (!res.ok) throw new Error(body.error ?? `Request failed: ${res.status}`);
  return body as VaultBackupTestResult;
}
export async function removeVaultBackupTarget(id: string): Promise<void> {
  await handleJson(await post(`/vault/backup-targets/${id}/remove`));
}
export async function runVaultBackup(): Promise<{ runs: VaultBackupRun[]; allOk: boolean }> {
  return handleJson(await post('/vault/backup'));
}
export async function fetchVaultBackupRuns(limit = 20): Promise<VaultBackupRun[]> {
  return handleJson(await fetch(`${getApiBase()}/vault/backup-runs?limit=${limit}`));
}
export interface RestoreVaultResult {
  clientsCreated: number;
  credentialsCreated: number;
  urlsCreated: number;
  itemsCreated: number;
  replicationTargetsCreated: number;
  vaultBackupTargetsCreated: number;
  clientErrors: { name: string; error: string }[];
  warnings: string[];
}
export async function restoreVault(fileBase64: string, password: string): Promise<RestoreVaultResult> {
  const s = await handleJson<RestoreVaultResult>(await post('/vault/restore', { fileBase64, password }));
  notifyVaultStatusChanged();
  return s;
}
