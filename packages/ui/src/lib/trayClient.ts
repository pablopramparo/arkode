import { isTauri, invoke } from '@tauri-apps/api/core';

/**
 * "Iniciar minimizado a la bandeja" — a small JSON file under Tauri's own
 * app_config_dir (see lib.rs's UiPrefs), deliberately separate from
 * engine-core's SQLite app_settings: this is a Tauri-shell/UI concern (does
 * the window show itself on launch), not application data. Read by Rust's
 * own setup() before the frontend ever mounts, so toggling it here only
 * takes effect on the *next* launch — not retroactive to the current window.
 */
export async function getStartMinimized(): Promise<boolean> {
  if (!isTauri()) return false;
  return invoke<boolean>('get_start_minimized');
}

export async function setStartMinimized(value: boolean): Promise<void> {
  await invoke('set_start_minimized', { value });
}

/**
 * Pushes the dashboard's current health to the tray icon (green/red dot +
 * tooltip) — see lib.rs's set_tray_status. Silently does nothing outside
 * Tauri (there is no tray in the plain browser dev workflow).
 */
export async function setTrayStatus(hasProblems: boolean, tooltip: string): Promise<void> {
  if (!isTauri()) return;
  await invoke('set_tray_status', { hasProblems, tooltip });
}
