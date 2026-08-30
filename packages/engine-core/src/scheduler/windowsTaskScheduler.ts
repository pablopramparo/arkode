import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildTaskDefinitionXml, type TaskDefinitionInput } from './taskDefinitionXml.js';

const execFileAsync = promisify(execFile);

/** Every child process here is a CLI helper (schtasks/net) — never let one flash a console window. */
const HIDDEN = { windowsHide: true } as const;

/** Groups every task this app creates under one visible folder in Task Scheduler's own UI. */
export function scheduledTaskNameForBackupTask(taskId: string): string {
  return `\\arkode\\${taskId}`;
}

/**
 * A human-readable Scheduled Task name — `\arkode\<task's own name> (<short
 * id>)` — computed once at registration time and then stored (see
 * tasksRepo.ts's `windowsTaskName` column), never recomputed from the task's
 * *current* name on every install/uninstall/status call. That storage is
 * deliberate: if this were recomputed live, renaming a task in arkode after
 * it was already registered would make uninstall/status compute a different
 * string than what's actually sitting in Task Scheduler, silently failing
 * to find it (schtasks has no id-based lookup, only name-based).
 *
 * Windows Scheduled Task names can't contain `\ / : * ? " < > |` — stripped
 * to a safe, still-readable set rather than rejecting a task name outright;
 * a short id suffix (not the full UUID — the point is readability, and the
 * full id is still in the app's own database either way) keeps two same-
 * named tasks from colliding.
 */
export function scheduledTaskDisplayName(taskId: string, taskName: string): string {
  const safeName = taskName.replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 200) || 'tarea';
  return `\\arkode\\${safeName} (${taskId.slice(0, 8)})`;
}

export interface InstallScheduledTaskInput extends TaskDefinitionInput {
  taskName: string;
}

/**
 * Registers (or replaces, via /F) a Windows Scheduled Task from a generated
 * XML definition. The XML file is written to a temp path only for the
 * duration of the schtasks call and removed immediately after.
 *
 * No credentials are involved: the task's Principal is always SYSTEM (see
 * taskDefinitionXml.ts), so there is no `/RU`/`/RP` to pass — the account
 * is fully specified inside the XML itself. This does mean the *calling*
 * process needs to be running elevated (as Administrator) to register a
 * task that runs as SYSTEM, which a real installer already runs as by
 * default; this is a one-time cost at setup, not a per-task one.
 */
export async function installScheduledTask(input: InstallScheduledTaskInput): Promise<void> {
  const xml = buildTaskDefinitionXml(input);
  const xmlPath = join(tmpdir(), `codebius-task-${randomUUID()}.xml`);
  // Task Scheduler's XML importer expects a real UTF-16LE BOM, not just the
  // <?xml encoding="UTF-16"?> declaration — Node's 'utf16le' encoding alone
  // does not write one.
  const BOM = String.fromCharCode(0xfeff);
  await writeFile(xmlPath, BOM + xml, { encoding: 'utf16le' });

  try {
    await execFileAsync('schtasks.exe', ['/Create', '/TN', input.taskName, '/XML', xmlPath, '/F'], HIDDEN);
  } finally {
    await unlink(xmlPath).catch(() => {});
  }
}

export async function uninstallScheduledTask(taskName: string): Promise<void> {
  await execFileAsync('schtasks.exe', ['/Delete', '/TN', taskName, '/F'], HIDDEN);
}

/**
 * Every Scheduled Task registered under the `\arkode\` folder (the per-task
 * `\arkode\<taskId>` entries + `\arkode\file-backup-maintenance`). Used by
 * `scheduler:cleanup-legacy` to tear down the pre-service scheduling model.
 * Returns `[]` if schtasks is unavailable or nothing is registered.
 *
 * Parses `/FO CSV /NH` (headerless), NOT `/FO LIST` — the LIST format's
 * field labels are localized (`Nombre de tarea:` on Spanish Windows, not
 * `TaskName:`), so the old label-anchored regex matched nothing there and
 * cleanup silently deleted nothing. CSV/NH rows are `"<full task path>",…`
 * with the path column never localized. Task display names can't contain a
 * `"` (scheduledTaskDisplayName strips it), so `[^"]+` is a safe field read.
 */
export async function listArkodeScheduledTaskNames(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('schtasks.exe', ['/Query', '/FO', 'CSV', '/NH'], HIDDEN);
    return parseArkodeTaskNamesFromCsv(stdout);
  } catch {
    return [];
  }
}

/** Pulls the `\arkode\*` task paths out of `schtasks /Query /FO CSV /NH` output. Exported for testing. */
export function parseArkodeTaskNamesFromCsv(stdout: string): string[] {
  return [
    ...new Set(
      stdout
        .split(/\r?\n/)
        .map((line) => /^"(\\arkode\\[^"]+)"/i.exec(line.trim())?.[1])
        .filter((name): name is string => Boolean(name)),
    ),
  ];
}

/** `net session` only succeeds when the current process is running elevated — no dedicated Node API for this on Windows. */
async function isRunningElevated(): Promise<boolean> {
  try {
    await execFileAsync('net', ['session'], HIDDEN);
    return true;
  } catch {
    return false;
  }
}

export interface ScheduledTaskStatus {
  exists: boolean;
  raw?: string;
  /**
   * True if this query itself ran non-elevated. Confirmed by hand against a
   * real Windows install: `schtasks /Query` on a SYSTEM-owned task fails
   * with the exact same "cannot find" error from a non-elevated caller as
   * it would for a task that was never registered at all — there is no way
   * to tell the two apart from schtasks.exe's own output. When this is
   * true, `exists: false` means "couldn't confirm," not "not registered."
   */
  ranNonElevated?: boolean;
}

export async function scheduledTaskStatus(taskName: string): Promise<ScheduledTaskStatus> {
  try {
    const { stdout } = await execFileAsync('schtasks.exe', ['/Query', '/TN', taskName, '/V', '/FO', 'LIST'], HIDDEN);
    return { exists: true, raw: stdout };
  } catch {
    const elevated = await isRunningElevated();
    return { exists: false, ranNonElevated: !elevated };
  }
}
