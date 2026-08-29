import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

export const SCHEDULER_SERVICE_NAME = 'arkode-scheduler';

export interface WindowsServiceStatus {
  installed: boolean;
  running: boolean;
  /** Raw SCM state token (RUNNING / STOPPED / START_PENDING / …), or null. */
  state: string | null;
}

/**
 * `sc query arkode-scheduler` → { installed, running }. A plain status read
 * needs no elevation, so the app spawns this directly. Exit code 1060 ("The
 * specified service does not exist") ⇒ not installed; any other failure is
 * reported conservatively as not-installed/not-running (the app then offers
 * Reinstalar, which is the right move either way).
 */
export async function schedulerServiceStatus(): Promise<WindowsServiceStatus> {
  try {
    const { stdout } = await execFileAsync('sc', ['query', SCHEDULER_SERVICE_NAME]);
    const state = /\bSTATE\b\s*:\s*\d+\s+([A-Z_]+)/.exec(stdout)?.[1] ?? null;
    return { installed: true, running: state === 'RUNNING', state };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/\b1060\b/.test(message) || /does not exist/i.test(message)) {
      return { installed: false, running: false, state: null };
    }
    return { installed: false, running: false, state: null };
  }
}

async function waitUntilStopped(timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await schedulerServiceStatus()).running) return;
    await new Promise((r) => setTimeout(r, 500));
  }
}

/**
 * Stop then start the service. `sc stop` returns before the service has
 * actually stopped, so poll briefly before `sc start` (starting a
 * still-stopping service fails). Elevation required — call via `runas`.
 */
export async function restartSchedulerService(): Promise<void> {
  await execFileAsync('sc', ['stop', SCHEDULER_SERVICE_NAME]).catch(() => {});
  await waitUntilStopped();
  await execFileAsync('sc', ['start', SCHEDULER_SERVICE_NAME]);
}

/**
 * Tear the service down and recreate it from scratch (fixes a corrupted /
 * partially-registered / never-installed service). `installDir` is the
 * arkode install root — `arkode-scheduler.exe` lives at
 * `<installDir>\resources\scheduler\`. Elevation required — call via `runas`.
 */
export async function reinstallSchedulerService(installDir: string): Promise<void> {
  const bin = join(installDir, 'resources', 'scheduler', 'arkode-scheduler.exe');
  await execFileAsync('sc', ['stop', SCHEDULER_SERVICE_NAME]).catch(() => {});
  await execFileAsync('sc', ['delete', SCHEDULER_SERVICE_NAME]).catch(() => {});
  await new Promise((r) => setTimeout(r, 500));
  await execFileAsync('sc', [
    'create',
    SCHEDULER_SERVICE_NAME,
    'binPath=',
    bin,
    'start=',
    'auto',
    'obj=',
    'LocalSystem',
    'DisplayName=',
    'arkode backup scheduler',
  ]);
  await execFileAsync('sc', [
    'failure',
    SCHEDULER_SERVICE_NAME,
    'reset=',
    '86400',
    'actions=',
    'restart/60000/restart/60000/restart/300000',
  ]).catch(() => {});
  await execFileAsync('sc', ['start', SCHEDULER_SERVICE_NAME]);
}
