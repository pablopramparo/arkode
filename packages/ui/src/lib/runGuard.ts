import { isTauri } from '@tauri-apps/api/core';
import { fetchDashboardStatus } from './statusClient';
import { isLiveProgress } from './progress';

/**
 * "Client · Task" labels for every task with a backup **genuinely running
 * right now** — an in-progress status AND a fresh progress heartbeat
 * (`isLiveProgress`), so a leftover `Producing` row from an earlier crash
 * does NOT count. Returns `[]` if nothing is live or the engine isn't
 * reachable. Callers use this to warn before an action that would kill a
 * run (closing the window, installing an update); it's a warning aid,
 * never a hard gate.
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
    return rows.filter((r) => isLiveProgress(r.status, r.progress)).map((r) => `${r.client} · ${r.task}`);
  } catch {
    return [];
  }
}

/**
 * "Proceed anyway?" confirmation naming the running backups. Uses Tauri's
 * NATIVE dialog inside the desktop app — `window.confirm` is unreliable
 * during a `close-requested` event (it can silently return false, which
 * would trap the user). Resolves `true` to proceed. On any failure it
 * resolves `true` (fail-open — never block the user).
 */
export async function confirmInterruptRunningBackups(labels: string[], lead: string): Promise<boolean> {
  const count = labels.length === 1 ? 'un backup en curso' : `${labels.length} backups en curso`;
  const message =
    `${lead}\n\nHay ${count}:\n${labels.map((l) => `  • ${l}`).join('\n')}\n\n` +
    'Si seguís ahora se interrumpe (queda como "Interrumpida" y se retoma en la próxima corrida).';
  if (isTauri()) {
    try {
      const { ask } = await import('@tauri-apps/plugin-dialog');
      return await ask(message, {
        title: 'Backup en curso',
        kind: 'warning',
        okLabel: 'Continuar igual',
        cancelLabel: 'Cancelar',
      });
    } catch {
      return true; // dialog unavailable — don't trap the user
    }
  }
  return window.confirm(`${message}\n\n¿Continuar igual?`);
}
