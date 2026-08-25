import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildTaskDefinitionXml, type TaskDefinitionInput } from './taskDefinitionXml.js';

const execFileAsync = promisify(execFile);

/** Groups every task this app creates under one visible folder in Task Scheduler's own UI. */
export function scheduledTaskNameForBackupTask(taskId: string): string {
  return `\\CodebiusBackupManager\\${taskId}`;
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
    await execFileAsync('schtasks.exe', ['/Create', '/TN', input.taskName, '/XML', xmlPath, '/F']);
  } finally {
    await unlink(xmlPath).catch(() => {});
  }
}

export async function uninstallScheduledTask(taskName: string): Promise<void> {
  await execFileAsync('schtasks.exe', ['/Delete', '/TN', taskName, '/F']);
}

/** `net session` only succeeds when the current process is running elevated — no dedicated Node API for this on Windows. */
async function isRunningElevated(): Promise<boolean> {
  try {
    await execFileAsync('net', ['session']);
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
    const { stdout } = await execFileAsync('schtasks.exe', ['/Query', '/TN', taskName, '/V', '/FO', 'LIST']);
    return { exists: true, raw: stdout };
  } catch {
    const elevated = await isRunningElevated();
    return { exists: false, ranNonElevated: !elevated };
  }
}
