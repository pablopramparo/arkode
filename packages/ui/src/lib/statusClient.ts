import type { BackupRun, ConnectionTestResult, DashboardRow, DirectDumpCompatibilityResult } from 'engine-core';
import { getApiBase } from './apiBase';

export async function fetchDashboardStatus(): Promise<DashboardRow[]> {
  const res = await fetch(`${getApiBase()}/status`);
  if (!res.ok) {
    throw new Error(`Status request failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function postTaskAction<T>(
  taskId: string,
  action: 'run' | 'test-connection' | 'test-compatibility',
  requestBody?: Record<string, unknown>
): Promise<T> {
  const res = await fetch(`${getApiBase()}/tasks/${taskId}/${action}`, {
    method: 'POST',
    ...(requestBody ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(requestBody) } : {}),
  });
  const body = await res.json();
  // 404 (unknown task) and 500 (unexpected exception) are real request-level errors.
  // 502 from test-connection/test-compatibility is an expected "failed" result, not a request error — body is still the respective result shape.
  if (res.status === 404 || res.status === 500) {
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  return body;
}

export function runTaskNow(taskId: string): Promise<BackupRun> {
  return postTaskAction<BackupRun>(taskId, 'run');
}

/** trustHost: true retries an unknown-host rejection (see ConnectionTestResult.unknownHost) as an explicit "yes, trust this host" — only ever call it after the person has seen the presented fingerprint and confirmed it. */
export function testTaskConnection(taskId: string, trustHost?: boolean): Promise<ConnectionTestResult> {
  return postTaskAction<ConnectionTestResult>(taskId, 'test-connection', trustHost ? { trustHost: true } : undefined);
}

/** direct_dump only — see testDirectDumpCompatibility in engine-core. */
export function testTaskCompatibility(taskId: string): Promise<DirectDumpCompatibilityResult> {
  return postTaskAction<DirectDumpCompatibilityResult>(taskId, 'test-compatibility');
}

export type { DashboardRow, BackupRun, ConnectionTestResult, DirectDumpCompatibilityResult };
