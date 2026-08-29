import { isTauri, invoke } from '@tauri-apps/api/core';
import { getApiBase } from './apiBase';

/** True only inside the real desktop app in production — dev mode (`tauri dev`) has no installed engine-cli.exe sibling to elevate, and the plain browser dev workflow has no Tauri at all. */
export function canRegisterTaskSchedule(): boolean {
  return isTauri();
}

// ─── arkode-scheduler Windows service (v0.3.0+) ─────────────────────────────
// The unattended scheduler. Installed + started by the elevated installer, so
// there is no per-task UAC. The per-task register* functions below are kept
// for CLI parity / the legacy model but are no longer surfaced in the UI.

export interface SchedulerServiceStatus {
  installed: boolean;
  running: boolean;
}

/** SCM state of the arkode-scheduler service. In dev / browser → `{ installed:false, running:false }` (the banner then shows its dev-mode message). */
export async function getSchedulerServiceStatus(): Promise<SchedulerServiceStatus> {
  if (!isTauri()) return { installed: false, running: false };
  return invoke<SchedulerServiceStatus>('scheduler_service_status');
}

/** Stop + start the service — one UAC prompt. Throws an already-actionable Spanish message on failure / cancelled prompt. */
export async function restartSchedulerService(): Promise<void> {
  await invoke('restart_scheduler_service');
}

/** Delete + recreate the service from this install — one UAC prompt. For a corrupted / missing service. */
export async function reinstallSchedulerService(): Promise<void> {
  await invoke('reinstall_scheduler_service');
}

/** When the service last completed a tick (heartbeat in app_settings), and how long ago. `heartbeatAt: null` ⇒ it has never ticked. */
export async function fetchSchedulerHeartbeat(): Promise<{ heartbeatAt: string | null; heartbeatAgeSeconds: number | null }> {
  const res = await fetch(`${getApiBase()}/scheduler-status`);
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.json();
}

/**
 * Registers a task's Windows Scheduled Task from the app itself — triggers
 * one real UAC prompt (see lib.rs's register_task_schedule), not silent,
 * not persistent elevation. Throws with a message meant to be shown
 * directly to the user (already in Spanish, already actionable) on
 * failure, including a cancelled UAC prompt.
 */
export async function registerTaskSchedule(taskId: string): Promise<void> {
  await invoke('register_task_schedule', { taskId });
}

/**
 * The removal-side mirror of registerTaskSchedule — deactivating a task
 * never does this automatically (it's a plain DB update, no elevation
 * needed, and forcing a UAC prompt on every deactivate would be bad UX for
 * a routine action) — this is a separate, explicit cleanup action so Task
 * Scheduler doesn't accumulate dead entries for deactivated tasks. Not
 * required for correctness: isTaskDue() already refuses to run anything
 * for an inactive task even if its Scheduled Task is still registered.
 */
export async function unregisterTaskSchedule(taskId: string): Promise<void> {
  await invoke('unregister_task_schedule', { taskId });
}

/**
 * File-backup mirror of registerTaskSchedule — same one-UAC-prompt,
 * production-only flow (see lib.rs's register_file_task_schedule), targeting
 * `engine-cli file-task:scheduler:install` instead. `canRegisterTaskSchedule()`
 * gates this identically.
 */
export async function registerFileTaskSchedule(taskId: string): Promise<void> {
  await invoke('register_file_task_schedule', { taskId });
}

/** Removal-side mirror of registerFileTaskSchedule — see unregisterTaskSchedule for the reasoning. */
export async function unregisterFileTaskSchedule(taskId: string): Promise<void> {
  await invoke('unregister_file_task_schedule', { taskId });
}
