import type { ConnectionTestResult, Transport, DatabaseConnection } from 'engine-core';
import { getApiBase } from './apiBase';

export interface TransportWithClientName extends Transport {
  clientName: string;
}

export interface DatabaseConnectionWithClientName extends DatabaseConnection {
  clientName: string;
}

export interface ConnectionsData {
  clients: { id: string; name: string; retentionCount: number | null; retentionDays: number | null }[];
  transports: TransportWithClientName[];
  databaseConnections: DatabaseConnectionWithClientName[];
}

export interface TransportInput {
  type: 'sftp' | 'ssh';
  clientId: string;
  name: string;
  host: string;
  port?: number;
  username: string;
  privateKeyPath: string;
  passphrase?: string;
  remotePath?: string;
  remoteFilePattern?: string | null;
  remoteCommand?: string;
  remoteOutputPathTemplate?: string;
  remoteCleanup?: boolean;
}

export interface DatabaseConnectionInput {
  clientId: string;
  name: string;
  engine: 'postgres' | 'mysql' | 'mariadb';
  host: string;
  port: number;
  databaseName: string;
  username: string;
  password?: string;
  sslMode?: string | null;
}

async function handleJson<T>(res: Response): Promise<T> {
  const body = await res.json();
  // 404/500 are real request-level errors; a 502 test result still carries a real ConnectionTestResult body.
  if (res.status === 404 || res.status === 500 || res.status === 400) {
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  return body;
}

export async function fetchConnections(opts: { includeInactive?: boolean } = {}): Promise<ConnectionsData> {
  const query = opts.includeInactive ? '?includeInactive=true' : '';
  return handleJson(await fetch(`${getApiBase()}/connections${query}`));
}

export async function createTransport(input: TransportInput): Promise<Transport> {
  return handleJson(
    await fetch(`${getApiBase()}/transports`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
  );
}

export async function updateTransport(id: string, patch: Partial<TransportInput>): Promise<Transport> {
  return handleJson(
    await fetch(`${getApiBase()}/transports/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
  );
}

export async function deactivateTransport(id: string): Promise<void> {
  await handleJson(await fetch(`${getApiBase()}/transports/${id}/deactivate`, { method: 'POST' }));
}

export async function reactivateTransport(id: string): Promise<void> {
  await handleJson(await fetch(`${getApiBase()}/transports/${id}/reactivate`, { method: 'POST' }));
}

export async function testTransport(id: string): Promise<ConnectionTestResult> {
  const res = await fetch(`${getApiBase()}/transports/${id}/test`, { method: 'POST' });
  const body = await res.json();
  if (res.status === 404 || res.status === 500) throw new Error(body.error ?? `Request failed: ${res.status}`);
  return body;
}

export async function createDatabaseConnection(input: DatabaseConnectionInput): Promise<DatabaseConnection> {
  return handleJson(
    await fetch(`${getApiBase()}/database-connections`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
  );
}

export async function updateDatabaseConnection(id: string, patch: Partial<DatabaseConnectionInput>): Promise<DatabaseConnection> {
  return handleJson(
    await fetch(`${getApiBase()}/database-connections/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
  );
}

export async function deactivateDatabaseConnection(id: string): Promise<void> {
  await handleJson(await fetch(`${getApiBase()}/database-connections/${id}/deactivate`, { method: 'POST' }));
}

export async function reactivateDatabaseConnection(id: string): Promise<void> {
  await handleJson(await fetch(`${getApiBase()}/database-connections/${id}/reactivate`, { method: 'POST' }));
}

export async function testDatabaseConnection(id: string): Promise<ConnectionTestResult> {
  const res = await fetch(`${getApiBase()}/database-connections/${id}/test`, { method: 'POST' });
  const body = await res.json();
  if (res.status === 404 || res.status === 500) throw new Error(body.error ?? `Request failed: ${res.status}`);
  return body;
}
