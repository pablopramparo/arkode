import { execFileSync } from 'node:child_process';

/**
 * `process.kill(pid, 0)` — true if *some* process currently holds this PID.
 * Says nothing about *which* process: the OS recycles PIDs, so this alone
 * cannot tell "our crashed run's process is still running" from "that PID
 * now belongs to an unrelated program". `isStaleInProgressRun` below layers
 * an identity check on top for exactly that reason.
 */
export function isPidInUse(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but we can't signal it (different user) — still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Epoch-ms creation time of the process currently holding `pid`, or null if
 * it can't be determined (no such process, query failed, non-Windows).
 * Windows-only real implementation — arkode is Windows-only — via CIM;
 * callers treat null as "unknown" and fall back to the age ceiling.
 */
export function processStartTimeMs(pid: number): number | null {
  if (process.platform !== 'win32') return null;
  try {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue; if ($p) { $p.CreationDate.ToUniversalTime().ToString("o") }`,
      ],
      { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }
    ).trim();
    if (!out) return null;
    const t = Date.parse(out);
    return Number.isNaN(t) ? null : t;
  } catch {
    return null;
  }
}

/**
 * A run/maintenance row that's been "in progress" longer than this while its
 * PID still looks alive is reclaimed even when we can't positively prove the
 * PID was recycled — a run that genuinely ran this long is pathological and
 * worth failing anyway. Deliberately generous so a real, slow first sync of
 * a large tree never trips it.
 */
export const MAX_IN_PROGRESS_RUN_MS = 24 * 60 * 60 * 1000;

/**
 * Below this age, an in-progress row with a live PID is simply trusted — the
 * overwhelmingly common healthy case (a run that really is running right
 * now) — so recovery pays no OS-query cost. Past it, and with the PID still
 * in use, we scrutinize: query the holder's start time and, if it started
 * *after* this row was written, it can't be the process that wrote the row —
 * a recycled PID — so the row is stale.
 */
export const IN_PROGRESS_SCRUTINY_AFTER_MS = 30 * 60 * 1000;

export interface StaleRunCheckDeps {
  now?: number;
  maxRunMs?: number;
  scrutinyAfterMs?: number;
  isPidInUse?: (pid: number) => boolean;
  processStartTimeMs?: (pid: number) => number | null;
}

/**
 * Whether an in-progress run row is actually dead and safe to reclaim.
 *
 *  - No PID recorded, or PID not in use            → stale (fast path).
 *  - PID in use, row younger than the scrutiny age → trust it (no OS call).
 *  - PID in use, row older: query the PID holder's start time.
 *      · holder started after the row was written  → recycled PID → stale.
 *      · holder started before / can't tell        → keep, unless the row is
 *        older than MAX_IN_PROGRESS_RUN_MS (then reclaim regardless).
 */
export function isStaleInProgressRun(
  run: { pid: number | null; startedAt: string },
  deps: StaleRunCheckDeps = {}
): boolean {
  const now = deps.now ?? Date.now();
  const maxRunMs = deps.maxRunMs ?? MAX_IN_PROGRESS_RUN_MS;
  const scrutinyAfterMs = deps.scrutinyAfterMs ?? IN_PROGRESS_SCRUTINY_AFTER_MS;
  const pidInUse = deps.isPidInUse ?? isPidInUse;
  const startTimeOf = deps.processStartTimeMs ?? processStartTimeMs;

  if (run.pid === null) return true;
  if (!pidInUse(run.pid)) return true;

  const startedAtMs = Date.parse(run.startedAt);
  const ageMs = now - startedAtMs; // NaN if startedAt is unparseable
  if (!Number.isNaN(ageMs) && ageMs <= scrutinyAfterMs) return false;

  const holderStartedAtMs = startTimeOf(run.pid);
  if (holderStartedAtMs !== null && !Number.isNaN(startedAtMs) && holderStartedAtMs > startedAtMs) {
    return true; // the PID's current owner started after our row — recycled PID
  }

  return !Number.isNaN(ageMs) && ageMs > maxRunMs;
}
