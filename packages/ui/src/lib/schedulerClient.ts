import { isTauri, invoke } from '@tauri-apps/api/core';

/** True only inside the real desktop app in production — dev mode (`tauri dev`) has no installed engine-cli.exe sibling to elevate, and the plain browser dev workflow has no Tauri at all. */
export function canRegisterTaskSchedule(): boolean {
  return isTauri();
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
