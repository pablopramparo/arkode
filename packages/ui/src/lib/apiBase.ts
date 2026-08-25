import { isTauri, invoke } from '@tauri-apps/api/core';

// engine-cli's `serve` command normally binds 4287, but falls back to an
// OS-assigned free port if 4287 is already taken on this machine (see
// engine-cli/src/index.ts and lib.rs) -- a fixed port can always collide
// with something else on a client's PC. 4287 is the correct default here
// regardless: it's exactly right for the plain browser dev workflow (no
// Tauri, `engine-cli serve --port 4287` started by hand per CLAUDE.md's
// "UI" section), and it's the right value to start with even inside Tauri,
// since resolveApiBase() below overwrites it before the app's first render
// once the real port is known.
let apiBase = 'http://127.0.0.1:4287';

export function getApiBase(): string {
  return apiBase;
}

/**
 * Resolves the real backend port and must be awaited once, before the app's
 * first render (see main.tsx) -- every client in lib/*Client.ts reads
 * getApiBase() synchronously, so it has to already be correct by the time
 * any component's effect fires its first fetch. A no-op in the plain
 * browser dev workflow (isTauri() false), and best-effort inside Tauri: if
 * the command errors or times out (see lib.rs's get_api_port), the default
 * 4287 is kept rather than leaving the app with no base URL at all.
 */
export async function resolveApiBase(): Promise<void> {
  if (!isTauri()) return;
  try {
    const port = await invoke<number>('get_api_port');
    apiBase = `http://127.0.0.1:${port}`;
  } catch {
    // Keep the 4287 default -- see the doc comment above.
  }
}
