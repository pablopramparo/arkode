import { fetchDashboardStatus } from './statusClient';
import { IN_PROGRESS_RUN_STATUSES } from './tasksClient';

/**
 * "Client · Task" labels for every task whose latest run is still in
 * progress, per `/status`. Returns `[]` if nothing is running OR the engine
 * isn't reachable — callers use this to warn before an action that would
 * kill a run (closing the window, installing an update). It is a warning
 * aid, never a hard gate.
 */
export async function inProgressRunLabels(): Promise<string[]> {
  try {
    // Cap the wait: this gates window-close, so a slow/unresponsive engine
    // must not make the app feel stuck — treat "no answer" as "nothing running".
    const rows = await Promise.race([
      fetchDashboardStatus(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
    ]);
    if (!rows) return [];
    return rows
      .filter((r) => (IN_PROGRESS_RUN_STATUSES as string[]).includes(r.status))
      .map((r) => `${r.client} · ${r.task}`);
  } catch {
    return [];
  }
}

/** A `window.confirm` naming the running backups; `true` = proceed anyway. */
export function confirmInterruptRunningBackups(labels: string[], lead: string): boolean {
  const count = labels.length === 1 ? 'un backup en curso' : `${labels.length} backups en curso`;
  return window.confirm(
    `${lead} Hay ${count}:\n  ${labels.join('\n  ')}\n\n` +
      'Si seguís ahora se interrumpe (queda como "Interrumpida" y se retoma en la próxima corrida). ¿Continuar igual?'
  );
}
