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
  /** "DOMAIN\User" — the same account named in TaskDefinitionInput.userId. */
  username: string;
  /**
   * The Windows account's actual login password. Passed straight through to
   * schtasks.exe as a CLI argument (Task Scheduler/LSA then stores it
   * securely) — this app never persists it anywhere itself.
   */
  password: string;
}

/**
 * Registers (or replaces, via /F) a Windows Scheduled Task from a generated
 * XML definition. The XML file is written to a temp path only for the
 * duration of the schtasks call and removed immediately after.
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
    await execFileAsync('schtasks.exe', [
      '/Create',
      '/TN',
      input.taskName,
      '/XML',
      xmlPath,
      '/RU',
      input.username,
      '/RP',
      input.password,
      '/F',
    ]);
  } catch (err) {
    // execFile's error embeds the full command line (including /RP
    // <password>) in both `.message` and `.cmd` — never let that reach a
    // caller, a log line, or a UI. Redact before rethrowing.
    throw new Error(redactPassword(err instanceof Error ? err.message : String(err), input.password));
  } finally {
    await unlink(xmlPath).catch(() => {});
  }
}

/** Exported for testing — strips every occurrence of `password` out of an error message. */
export function redactPassword(message: string, password: string): string {
  return message.split(password).join('[redacted]');
}

export async function uninstallScheduledTask(taskName: string): Promise<void> {
  await execFileAsync('schtasks.exe', ['/Delete', '/TN', taskName, '/F']);
}

export interface ScheduledTaskStatus {
  exists: boolean;
  raw?: string;
}

export async function scheduledTaskStatus(taskName: string): Promise<ScheduledTaskStatus> {
  try {
    const { stdout } = await execFileAsync('schtasks.exe', ['/Query', '/TN', taskName, '/V', '/FO', 'LIST']);
    return { exists: true, raw: stdout };
  } catch {
    return { exists: false };
  }
}
