import { useEffect } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { fetchDashboardStatus } from './statusClient';
import { isProblemRow } from './runStatus';
import { setTrayStatus } from './trayClient';

const POLL_MS = 30_000;

function buildTooltip(problemCount: number): string {
  if (problemCount === 0) return 'arkode — todo funcionando bien';
  if (problemCount === 1) return 'arkode — 1 tarea necesita atención';
  return `arkode — ${problemCount} tareas necesitan atención`;
}

/**
 * Keeps the tray icon's color + tooltip in sync with the dashboard's own
 * "does everything have a recent, valid backup?" judgment (isProblemRow —
 * shared with Dashboard.tsx so the tray never disagrees with what the
 * Dashboard itself would flag). Mounted once at the app-shell level, not
 * inside Dashboard.tsx, so the tray stays accurate no matter which screen is
 * open — or whether the window is even visible at all (hidden in the tray).
 * A no-op outside Tauri.
 */
export function useTraySync() {
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;

    async function sync() {
      try {
        const rows = await fetchDashboardStatus();
        if (cancelled) return;
        const problemCount = rows.filter(isProblemRow).length;
        await setTrayStatus(problemCount > 0, buildTooltip(problemCount));
      } catch {
        // The sidecar may not be up yet (right after launch) or a poll may
        // transiently fail — leave the tray showing its last-known state
        // rather than flipping to an alarming "alert" icon on a fluke.
      }
    }

    void sync();
    const id = setInterval(() => void sync(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);
}
