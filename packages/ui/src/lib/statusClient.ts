import type { BackupRun, ConnectionTestResult, DashboardRow, DirectDumpCompatibilityResult } from 'engine-core';

// Dev-time only: talks to `engine-cli serve` directly over HTTP. Once the
// Tauri shell exists, this should be replaced with either the same server
// reached through the shell's sidecar, or one-shot subprocess calls via
// tauri-plugin-shell — see CLAUDE.md.
const BASE_URL = 'http://127.0.0.1:4287';

export async function fetchDashboardStatus(): Promise<DashboardRow[]> {
  const res = await fetch(`${BASE_URL}/status`);
  if (!res.ok) {
    throw new Error(`Status request failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function postTaskAction<T>(taskId: string, action: 'run' | 'test-connection' | 'test-compatibility'): Promise<T> {
  const res = await fetch(`${BASE_URL}/tasks/${taskId}/${action}`, { method: 'POST' });
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

export function testTaskConnection(taskId: string): Promise<ConnectionTestResult> {
  return postTaskAction<ConnectionTestResult>(taskId, 'test-connection');
}

/** direct_dump only — see testDirectDumpCompatibility in engine-core. */
export function testTaskCompatibility(taskId: string): Promise<DirectDumpCompatibilityResult> {
  return postTaskAction<DirectDumpCompatibilityResult>(taskId, 'test-compatibility');
}

export type { DashboardRow, BackupRun, ConnectionTestResult, DirectDumpCompatibilityResult };
