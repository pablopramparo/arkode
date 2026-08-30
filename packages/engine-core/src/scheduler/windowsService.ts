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
 * `Get-Service` → { installed, running }. A plain status read needs no
 * elevation, so the app spawns this directly. PowerShell's
 * ServiceControllerStatus enum ("Running"/"Stopped"/…) is **not localized**
 * — unlike `sc query`'s field labels, which are (this bit us: a Spanish
 * Windows prints "ESTADO" not "STATE", so the old `sc query` regex always
 * reported a running service as stopped). "NOTFOUND" ⇒ not installed.
 */
export async function schedulerServiceStatus(): Promise<WindowsServiceStatus> {
  try {
    const { stdout } = await execFileAsync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$s = Get-Service '${SCHEDULER_SERVICE_NAME}' -ErrorAction SilentlyContinue; if ($s) { $s.Status } else { 'NOTFOUND' }`,
      ],
      // Never let a status read flash a console window (the app polls this).
      { windowsHide: true },
    );
    const state = stdout.trim();
    if (state === 'NOTFOUND' || state === '') {
      return { installed: false, running: false, state: null };
    }
    return { installed: true, running: state === 'Running', state };
  } catch (err) {
    // PowerShell itself failed — can't tell; conservative "reinstall" prompt.
    void err;
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
  await execFileAsync('sc', ['stop', SCHEDULER_SERVICE_NAME], { windowsHide: true }).catch(() => {});
  await waitUntilStopped();
  await execFileAsync('sc', ['start', SCHEDULER_SERVICE_NAME], { windowsHide: true });
}

/**
 * Tear the service down and recreate it from scratch (fixes a corrupted /
 * partially-registered / never-installed service). `installDir` is the
 * arkode install root — `arkode-scheduler.exe` lives at
 * `<installDir>\resources\scheduler\`. Elevation required — call via `runas`.
 */
export async function reinstallSchedulerService(installDir: string): Promise<void> {
  const bin = join(installDir, 'resources', 'scheduler', 'arkode-scheduler.exe');
  const hidden = { windowsHide: true } as const;
  await execFileAsync('sc', ['stop', SCHEDULER_SERVICE_NAME], hidden).catch(() => {});
  await execFileAsync('sc', ['delete', SCHEDULER_SERVICE_NAME], hidden).catch(() => {});
  await new Promise((r) => setTimeout(r, 500));
  await execFileAsync(
    'sc',
    [
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
    ],
    hidden,
  );
  await execFileAsync(
    'sc',
    [
      'failure',
      SCHEDULER_SERVICE_NAME,
      'reset=',
      '86400',
      'actions=',
      'restart/60000/restart/60000/restart/300000',
    ],
    hidden,
  ).catch(() => {});
  await execFileAsync('sc', ['start', SCHEDULER_SERVICE_NAME], hidden);
}
