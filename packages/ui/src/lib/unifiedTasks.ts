import type { BackupStrategyKind, BackupRunStatus, ScheduleFrequency } from 'engine-core';
import type { TaskRow } from './tasksClient';
import type { FileBackupTaskRow, FileBackupRunStatus } from './fileBackupClient';

/**
 * The shared row shape the unified Tareas surfaces (global screen + the
 * client ficha's "Tareas" tab) render over — DB-dump tasks (`backup_tasks`)
 * and restic-backed file tasks (`file_backup_tasks`) side by side, told
 * apart by `kind`. Actions and a couple of columns branch on `kind`;
 * everything the shared cells need is flattened onto this object, and
 * `raw` carries the untouched original for the kind-specific modals.
 */
export interface UnifiedTaskRow {
  kind: 'db' | 'file';
  id: string;
  clientId: string;
  clientName: string;
  name: string;
  isActive: boolean;
  /** DB: the dump strategy. File: the folder source kind. Drives the type badge. */
  strategy: BackupStrategyKind | 'local_folder' | 'remote_folder';
  /** Human-readable source: transport / DB-connection name, or folder path. */
  originLabel: string;
  scheduleTime: string | null;
  scheduleEnabled: boolean;
  scheduleFrequency: ScheduleFrequency;
  scheduleDaysOfWeek: number[] | null;
  scheduleDayOfMonth: number | null;
  backupSetName: string | null;
  latestRunStatus: BackupRunStatus | FileBackupRunStatus | null;
  /** Non-null ⇒ the task's schedule is actually registered in Windows Task Scheduler. */
  windowsTaskName: string | null;
  raw: TaskRow | FileBackupTaskRow;
}

function dbOriginLabel(t: TaskRow): string {
  return t.transportName ?? t.databaseConnectionName ?? '—';
}

function fileOriginLabel(t: FileBackupTaskRow): string {
  if (t.sourceKind === 'local_folder') return t.sourcePath ?? '—';
  return `${t.transportName ?? '?'} — ${t.remoteSourcePath ?? '?'}`;
}

export function toUnifiedDbTask(t: TaskRow): UnifiedTaskRow {
  return {
    kind: 'db',
    id: t.id,
    clientId: t.clientId,
    clientName: t.clientName,
    name: t.name,
    isActive: t.isActive,
    strategy: t.strategy,
    originLabel: dbOriginLabel(t),
    scheduleTime: t.scheduleTime,
    scheduleEnabled: t.scheduleEnabled,
    scheduleFrequency: t.scheduleFrequency,
    scheduleDaysOfWeek: t.scheduleDaysOfWeek,
    scheduleDayOfMonth: t.scheduleDayOfMonth,
    backupSetName: t.backupSetName,
    latestRunStatus: t.latestRunStatus,
    windowsTaskName: t.windowsTaskName,
    raw: t,
  };
}

export function toUnifiedFileTask(t: FileBackupTaskRow): UnifiedTaskRow {
  return {
    kind: 'file',
    id: t.id,
    clientId: t.clientId,
    clientName: t.clientName,
    name: t.name,
    isActive: t.isActive,
    strategy: t.sourceKind,
    originLabel: fileOriginLabel(t),
    scheduleTime: t.scheduleTime,
    scheduleEnabled: t.scheduleEnabled,
    scheduleFrequency: t.scheduleFrequency,
    scheduleDaysOfWeek: t.scheduleDaysOfWeek,
    scheduleDayOfMonth: t.scheduleDayOfMonth,
    backupSetName: t.backupSetName,
    latestRunStatus: t.latestRunStatus,
    windowsTaskName: t.windowsTaskName,
    raw: t,
  };
}

/** DB tasks first, then file tasks; each group keeps the server's own ordering. */
export function mergeTasks(dbTasks: TaskRow[], fileTasks: FileBackupTaskRow[]): UnifiedTaskRow[] {
  return [...dbTasks.map(toUnifiedDbTask), ...fileTasks.map(toUnifiedFileTask)];
}

const STRATEGY_LABEL: Record<UnifiedTaskRow['strategy'], string> = {
  fetch_existing: 'SFTP existente',
  remote_dump: 'SSH remoto',
  direct_dump: 'Conexión directa a BD',
  local_folder: 'Carpeta local',
  remote_folder: 'Carpeta remota',
};

export function strategyLabel(strategy: UnifiedTaskRow['strategy']): string {
  return STRATEGY_LABEL[strategy];
}

const IN_PROGRESS: string[] = ['Running', 'Producing', 'Validating'];

export function isUnifiedTaskInProgress(row: UnifiedTaskRow): boolean {
  return row.latestRunStatus != null && IN_PROGRESS.includes(row.latestRunStatus);
}

/**
 * A scheduled, active task that isn't actually registered in Windows Task
 * Scheduler — it will never run on its own. Mirrors Tareas.tsx's original
 * isScheduleNotRegistered, now covering both domains.
 */
export function isUnifiedScheduleNotRegistered(row: UnifiedTaskRow): boolean {
  return row.isActive && row.scheduleEnabled && Boolean(row.scheduleTime) && !row.windowsTaskName;
}
