export interface TaskDefinitionInput {
  description: string;
  /** 24h "HH:MM", local time. */
  scheduleTime: string;
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

/** How often the CalendarTrigger re-fires across the day — see the doc comment on buildTaskDefinitionXml for why it polls instead of firing once. */
export const POLL_INTERVAL = 'PT30M';

/**
 * Builds a Task Scheduler v1.4 XML task definition.
 *
 * The CalendarTrigger is anchored at `scheduleTime` but carries a
 * `<Repetition>` of every 30 minutes for a full day — so Windows invokes
 * `engine-cli run-due` roughly every half hour, all day, every day, rather
 * than once at a fixed time. `isTaskDue()` (which reads the task's *live*
 * `schedule_time`/frequency/days from the DB on every call) is what decides
 * whether this particular half-hour tick actually runs anything. This is
 * deliberate: it means editing a task's time or frequency in arkode takes
 * effect immediately with **no need to re-register the Windows task** — the
 * XML no longer encodes the specific time, only "check often". A backup can
 * start up to ~30 min after its nominal time, which is fine for daily/
 * weekly/monthly backups. Same "OS trigger just nudges, code gates" split
 * the weekly/monthly frequencies and the LogonTrigger catch-up already use.
 *
 * The LogonTrigger (delayed 2 minutes) stays as a faster catch-up path
 * after a boot than waiting for the next half-hour tick. Redundant
 * same-day firing across all of these is handled by isTaskDue()/
 * runDueTasks() (the "no *scheduled* attempt yet today" guard), not here.
 * The LogonTrigger has no `<UserId>` filter, so it fires on *any* user's
 * logon — irrelevant to who triggered it, since the task always runs as
 * SYSTEM regardless (see Principal below).
 *
 * Principal is always the built-in SYSTEM account — deliberately, and a
 * change from this app's original design (which ran as the interactive
 * user with LogonType=Password). That design required the user's real
 * Windows account password at registration time, because Windows
 * Credential Manager secrets are CurrentUser-scope DPAPI-protected and
 * only decryptable within that user's own login session — S4U logon never
 * supplies the password, so it couldn't decrypt them either. Secrets now
 * live in this app's own SQLite table, encrypted with LocalMachine-scope
 * DPAPI instead (see secrets/machineDpapiStore.ts) — decryptable by *any*
 * account on this machine, SYSTEM included, with no password anywhere in
 * the loop. This is what a real Windows password prompt during "install
 * the app on a client's PC" would have meant for a non-technical user, and
 * why it was worth the schema/secret-storage migration to avoid entirely.
 *
 * `UserId` is the well-known SID `S-1-5-18`, not the literal string
 * "SYSTEM" — schtasks.exe's own XML importer rejected the literal name
 * with a schema error ("(22,35):LogonType:ServiceAccount") when paired
 * with `LogonType=ServiceAccount`, confirmed by hand against a real
 * Windows install. The combination that actually works, and is what's
 * used here: the SID alone with `RunLevel=HighestAvailable`, no
 * `<LogonType>` element at all — Task Scheduler infers a service-account
 * logon from the well-known SID. `RunLevel` is technically a no-op for
 * SYSTEM (which already runs at maximum privilege regardless of this
 * value), kept for schema clarity rather than because it changes anything.
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
      <Repetition>
        <Interval>${POLL_INTERVAL}</Interval>
        <Duration>P1D</Duration>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
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
      <UserId>S-1-5-18</UserId>
      <RunLevel>HighestAvailable</RunLevel>
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
