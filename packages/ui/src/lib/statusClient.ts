import type { DashboardRow } from 'engine-core';

// Dev-time only: talks to `engine-cli serve`'s read-only /status endpoint
// directly over HTTP. Once the Tauri shell exists, this should be replaced
// with either the same server reached through the shell's sidecar, or
// one-shot subprocess calls via tauri-plugin-shell — see CLAUDE.md.
const STATUS_URL = 'http://127.0.0.1:4287/status';

export async function fetchDashboardStatus(): Promise<DashboardRow[]> {
  const res = await fetch(STATUS_URL);
  if (!res.ok) {
    throw new Error(`Status request failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

export type { DashboardRow };
