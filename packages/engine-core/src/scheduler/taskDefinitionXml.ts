export interface TaskDefinitionInput {
  description: string;
  /** 24h "HH:MM", local time. */
  scheduleTime: string;
  /** "DOMAIN\User" (or ".\User" for a local account) — must match the Principal that will own the task. */
  userId: string;
  /** Absolute path to the executable to run (e.g. node.exe, or the future compiled engine-cli.exe). */
  command: string;
  /** Full argument string, e.g. `"C:\...\dist\index.js" run-due --task <id>`. */
  arguments: string;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Builds a Task Scheduler v1.4 XML task definition with two triggers: a
 * daily CalendarTrigger at scheduleTime, and a LogonTrigger (delayed 2
 * minutes) as a catch-up path for a PC that was off at the scheduled time.
 * Redundant same-day double-firing between the two is handled by
 * isTaskDue()/runDueTasks(), not by anything here — this XML only concerns
 * itself with getting the process invoked at the right moments.
 *
 * LogonType is deliberately Password, not S4U: Windows Credential Manager
 * secrets (SSH passphrases, DB passwords) are DPAPI-protected using a key
 * derived from the account's actual password. S4U logon never supplies
 * that password, so a task created with S4U would run but be unable to
 * decrypt the very secrets it needs — this is the same per-user DPAPI
 * constraint already noted for why the task must run as the interactive
 * user rather than SYSTEM, extended to why the logon *type* matters too.
 */
export function buildTaskDefinitionXml(input: TaskDefinitionInput): string {
  const now = new Date();
  const startBoundary = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${input.scheduleTime}:00`;

  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${escapeXml(input.description)}</Description>
  </RegistrationInfo>
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>${startBoundary}</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByDay>
        <DaysInterval>1</DaysInterval>
      </ScheduleByDay>
    </CalendarTrigger>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <Delay>PT2M</Delay>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${escapeXml(input.userId)}</UserId>
      <LogonType>Password</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT6H</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${escapeXml(input.command)}</Command>
      <Arguments>${escapeXml(input.arguments)}</Arguments>
    </Exec>
  </Actions>
</Task>`;
}
