import type { Database } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { ScheduleFrequency } from '../../../types.js';
import type { TransportsRepo } from '../../../db/repositories/transportsRepo.js';
import type { FileBackupTask } from '../../types.js';

interface FileBackupTaskRow {
  id: string;
  client_id: string;
  repository_id: string;
  name: string;
  source_kind: string;
  source_path: string | null;
  transport_id: string | null;
  remote_source_path: string | null;
  retention_count: number | null;
  retention_days: number | null;
  schedule_time: string | null;
  schedule_enabled: number;
  schedule_frequency: string;
  schedule_days_of_week: string | null;
  schedule_day_of_month: number | null;
  is_active: number;
  created_at: string;
  updated_at: string;
  backup_set_id: string | null;
  windows_task_name: string | null;
}

function parseDaysOfWeek(csv: string | null): number[] | null {
  if (!csv) return null;
  return csv.split(',').map(Number);
}

function toDomain(row: FileBackupTaskRow): FileBackupTask {
  return {
    id: row.id,
    clientId: row.client_id,
    repositoryId: row.repository_id,
    name: row.name,
    sourceKind: row.source_kind as FileBackupTask['sourceKind'],
    sourcePath: row.source_path,
    transportId: row.transport_id,
    remoteSourcePath: row.remote_source_path,
    retentionCount: row.retention_count,
    retentionDays: row.retention_days,
    scheduleTime: row.schedule_time,
    scheduleEnabled: row.schedule_enabled === 1,
    scheduleFrequency: row.schedule_frequency as ScheduleFrequency,
    scheduleDaysOfWeek: parseDaysOfWeek(row.schedule_days_of_week),
    scheduleDayOfMonth: row.schedule_day_of_month,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    backupSetId: row.backup_set_id,
    windowsTaskName: row.windows_task_name,
  };
}

export interface CreateLocalFolderTaskInput {
  clientId: string;
  repositoryId: string;
  name: string;
  /** Must already be an absolute Windows path — callers resolve this before calling create(), the repo does not resolve it for them. */
  sourcePath: string;
  retentionCount?: number | null;
  retentionDays?: number | null;
  backupSetId?: string | null;
}

export interface CreateRemoteFolderTaskInput {
  clientId: string;
  repositoryId: string;
  name: string;
  /** Must be an sftp or ftp transport — validated against transportsRepo, since the schema CHECK can't express "which transport type" across tables (same app-level invariant pattern as tasksRepo.ts's insertTransportBackedTask). */
  transportId: string;
  /** The folder's path on the remote host — POSIX-style, whatever the remote server expects (never validated as a Windows path). */
  remoteSourcePath: string;
  retentionCount?: number | null;
  retentionDays?: number | null;
  backupSetId?: string | null;
}

export interface SetFileBackupScheduleInput {
  scheduleTime: string | null;
  scheduleEnabled: boolean;
  scheduleFrequency?: ScheduleFrequency;
  scheduleDaysOfWeek?: number[] | null;
  scheduleDayOfMonth?: number | null;
}

/**
 * `sourceKind`/`transportId`/`repositoryId` stay immutable — those reshape
 * the pipeline, so create a new task instead. `backupSetId` is editable
 * (see tasksRepo.ts's UpdateTaskInput). `sourcePath` (local_folder) and
 * `remoteSourcePath` (remote_folder) are editable **only while the task has
 * no snapshots yet** — repointing after a real backup exists would leave
 * that task's history a mix of two different folders under one tag (and,
 * for local_folder, orphan the old snapshots from retention's `--path`
 * filter). Once snapshots exist, create a new task. Only the field matching
 * the task's own `sourceKind` may be set.
 */
export interface UpdateFileBackupTaskInput {
  name?: string;
  retentionCount?: number | null;
  retentionDays?: number | null;
  backupSetId?: string | null;
  /** local_folder tasks only — absolute Windows path. */
  sourcePath?: string;
  /** remote_folder tasks only — path on the remote host. */
  remoteSourcePath?: string;
}

const SCHEDULE_TIME_FORMAT = /^([01]\d|2[0-3]):[0-5]\d$/;
const ABSOLUTE_WINDOWS_PATH = /^[A-Za-z]:\\/;

export interface FileBackupTasksRepo {
  createLocalFolder(input: CreateLocalFolderTaskInput): FileBackupTask;
  createRemoteFolder(input: CreateRemoteFolderTaskInput): FileBackupTask;
  update(id: string, patch: UpdateFileBackupTaskInput): FileBackupTask;
  deactivate(id: string): void;
  reactivate(id: string): void;
  getById(id: string): FileBackupTask | null;
  listByClient(clientId: string): FileBackupTask[];
  listByRepository(repositoryId: string): FileBackupTask[];
  /** Every active task with a schedule configured and enabled — what file-task run-due iterates over. */
  listScheduled(): FileBackupTask[];
  setSchedule(taskId: string, input: SetFileBackupScheduleInput): FileBackupTask;
  /** Records (or clears, with null) the registered Windows Scheduled Task name — mirror of tasksRepo.setWindowsTaskName. */
  setWindowsTaskName(taskId: string, windowsTaskName: string | null): FileBackupTask;
}

export function createFileBackupTasksRepo(db: Database, transportsRepo: TransportsRepo): FileBackupTasksRepo {
  const insertLocalStmt = db.prepare(
    `INSERT INTO file_backup_tasks
       (id, client_id, repository_id, name, source_kind, source_path, retention_count, retention_days, backup_set_id)
     VALUES
       (@id, @clientId, @repositoryId, @name, 'local_folder', @sourcePath, @retentionCount, @retentionDays, @backupSetId)`
  );
  const insertRemoteStmt = db.prepare(
    `INSERT INTO file_backup_tasks
       (id, client_id, repository_id, name, source_kind, transport_id, remote_source_path, retention_count, retention_days, backup_set_id)
     VALUES
       (@id, @clientId, @repositoryId, @name, 'remote_folder', @transportId, @remoteSourcePath, @retentionCount, @retentionDays, @backupSetId)`
  );
  const getByIdStmt = db.prepare<[string], FileBackupTaskRow>('SELECT * FROM file_backup_tasks WHERE id = ?');
  const hasSnapshotStmt = db.prepare<[string], { one: number }>(
    `SELECT 1 AS one FROM file_backup_runs WHERE task_id = ? AND snapshot_id IS NOT NULL LIMIT 1`
  );
  const listByClientStmt = db.prepare<[string], FileBackupTaskRow>(
    'SELECT * FROM file_backup_tasks WHERE client_id = ? ORDER BY name'
  );
  const listByRepositoryStmt = db.prepare<[string], FileBackupTaskRow>(
    'SELECT * FROM file_backup_tasks WHERE repository_id = ? ORDER BY name'
  );
  const listScheduledStmt = db.prepare<[], FileBackupTaskRow>(
    `SELECT * FROM file_backup_tasks WHERE is_active = 1 AND schedule_enabled = 1 AND schedule_time IS NOT NULL`
  );
  const setScheduleStmt = db.prepare(
    `UPDATE file_backup_tasks
     SET schedule_time = @scheduleTime, schedule_enabled = @scheduleEnabled,
         schedule_frequency = @scheduleFrequency, schedule_days_of_week = @scheduleDaysOfWeek,
         schedule_day_of_month = @scheduleDayOfMonth, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = @taskId`
  );
  const updateStmt = db.prepare(
    `UPDATE file_backup_tasks
     SET name = @name, retention_count = @retentionCount, retention_days = @retentionDays, backup_set_id = @backupSetId,
         source_path = @sourcePath, remote_source_path = @remoteSourcePath,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = @id`
  );
  const deactivateStmt = db.prepare(
    `UPDATE file_backup_tasks SET is_active = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
  );
  const reactivateStmt = db.prepare(
    `UPDATE file_backup_tasks SET is_active = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
  );
  const setWindowsTaskNameStmt = db.prepare(
    `UPDATE file_backup_tasks SET windows_task_name = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
  );

  return {
    createLocalFolder(input) {
      if (!ABSOLUTE_WINDOWS_PATH.test(input.sourcePath)) {
        throw new Error(`sourcePath must be an absolute Windows path (e.g. "D:\\Uploads"); got "${input.sourcePath}".`);
      }
      const id = randomUUID();
      insertLocalStmt.run({
        id,
        clientId: input.clientId,
        repositoryId: input.repositoryId,
        name: input.name,
        sourcePath: input.sourcePath,
        retentionCount: input.retentionCount ?? null,
        retentionDays: input.retentionDays ?? null,
        backupSetId: input.backupSetId ?? null,
      });
      const row = getByIdStmt.get(id);
      if (!row) throw new Error(`Failed to read back created file_backup_task ${id}`);
      return toDomain(row);
    },

    createRemoteFolder(input) {
      const transport = transportsRepo.getById(input.transportId);
      if (!transport) {
        throw new Error(`Transport ${input.transportId} not found.`);
      }
      if (transport.type !== 'sftp' && transport.type !== 'ftp') {
        throw new Error(`remote_folder tasks require an sftp or ftp transport; transport ${input.transportId} is "${transport.type}".`);
      }
      if (!input.remoteSourcePath.trim()) {
        throw new Error('remoteSourcePath is required for a remote_folder task.');
      }
      const id = randomUUID();
      insertRemoteStmt.run({
        id,
        clientId: input.clientId,
        repositoryId: input.repositoryId,
        name: input.name,
        transportId: input.transportId,
        remoteSourcePath: input.remoteSourcePath,
        retentionCount: input.retentionCount ?? null,
        retentionDays: input.retentionDays ?? null,
        backupSetId: input.backupSetId ?? null,
      });
      const row = getByIdStmt.get(id);
      if (!row) throw new Error(`Failed to read back created file_backup_task ${id}`);
      return toDomain(row);
    },

    update(id, patch) {
      const current = getByIdStmt.get(id);
      if (!current) throw new Error(`File-backup task ${id} not found.`);

      let sourcePath = current.source_path;
      let remoteSourcePath = current.remote_source_path;
      const changingSource =
        (patch.sourcePath !== undefined && patch.sourcePath !== current.source_path) ||
        (patch.remoteSourcePath !== undefined && patch.remoteSourcePath !== current.remote_source_path);
      if (changingSource && hasSnapshotStmt.get(id)) {
        throw new Error(
          'This task already has snapshots — its source folder is locked in. Create a new task to back up a different folder.'
        );
      }
      if (patch.sourcePath !== undefined) {
        if (current.source_kind !== 'local_folder') {
          throw new Error(`sourcePath only applies to a local_folder task; task ${id} is "${current.source_kind}".`);
        }
        if (!ABSOLUTE_WINDOWS_PATH.test(patch.sourcePath)) {
          throw new Error(`sourcePath must be an absolute Windows path (e.g. "D:\\Uploads"); got "${patch.sourcePath}".`);
        }
        sourcePath = patch.sourcePath;
      }
      if (patch.remoteSourcePath !== undefined) {
        if (current.source_kind !== 'remote_folder') {
          throw new Error(`remoteSourcePath only applies to a remote_folder task; task ${id} is "${current.source_kind}".`);
        }
        if (!patch.remoteSourcePath.trim()) {
          throw new Error('remoteSourcePath cannot be empty.');
        }
        remoteSourcePath = patch.remoteSourcePath;
      }

      updateStmt.run({
        id,
        name: patch.name ?? current.name,
        retentionCount: patch.retentionCount !== undefined ? patch.retentionCount : current.retention_count,
        retentionDays: patch.retentionDays !== undefined ? patch.retentionDays : current.retention_days,
        backupSetId: patch.backupSetId !== undefined ? patch.backupSetId : current.backup_set_id,
        sourcePath,
        remoteSourcePath,
      });
      const row = getByIdStmt.get(id);
      if (!row) throw new Error(`Failed to read back updated file_backup_task ${id}`);
      return toDomain(row);
    },

    deactivate(id) {
      const current = getByIdStmt.get(id);
      if (!current) throw new Error(`File-backup task ${id} not found.`);
      deactivateStmt.run(id);
    },

    reactivate(id) {
      const current = getByIdStmt.get(id);
      if (!current) throw new Error(`File-backup task ${id} not found.`);
      reactivateStmt.run(id);
    },

    getById(id) {
      const row = getByIdStmt.get(id);
      return row ? toDomain(row) : null;
    },

    listByClient(clientId) {
      return listByClientStmt.all(clientId).map(toDomain);
    },

    listByRepository(repositoryId) {
      return listByRepositoryStmt.all(repositoryId).map(toDomain);
    },

    listScheduled() {
      return listScheduledStmt.all().map(toDomain);
    },

    setWindowsTaskName(taskId, windowsTaskName) {
      const existing = getByIdStmt.get(taskId);
      if (!existing) throw new Error(`File-backup task ${taskId} not found.`);
      setWindowsTaskNameStmt.run(windowsTaskName, taskId);
      const row = getByIdStmt.get(taskId);
      if (!row) throw new Error(`Failed to read back file_backup_task ${taskId} after setting its Windows task name.`);
      return toDomain(row);
    },

    setSchedule(taskId, input) {
      if (input.scheduleTime !== null && !SCHEDULE_TIME_FORMAT.test(input.scheduleTime)) {
        throw new Error(`Invalid schedule time "${input.scheduleTime}" — expected 24h "HH:MM".`);
      }
      const existing = getByIdStmt.get(taskId);
      if (!existing) throw new Error(`File-backup task ${taskId} not found.`);

      const frequency: ScheduleFrequency = input.scheduleFrequency ?? (existing.schedule_frequency as ScheduleFrequency);

      let daysOfWeek: number[] | null = null;
      let dayOfMonth: number | null = null;

      if (frequency === 'weekly') {
        daysOfWeek = input.scheduleDaysOfWeek !== undefined ? input.scheduleDaysOfWeek : parseDaysOfWeek(existing.schedule_days_of_week);
        if (!daysOfWeek || daysOfWeek.length === 0) {
          throw new Error('Weekly schedules require at least one day of the week (scheduleDaysOfWeek).');
        }
        if (daysOfWeek.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
          throw new Error('scheduleDaysOfWeek must contain integers 0 (Sunday) through 6 (Saturday).');
        }
      } else if (frequency === 'monthly') {
        dayOfMonth = input.scheduleDayOfMonth !== undefined ? input.scheduleDayOfMonth : existing.schedule_day_of_month;
        if (dayOfMonth == null || !Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31) {
          throw new Error('Monthly schedules require scheduleDayOfMonth between 1 and 31.');
        }
      }

      setScheduleStmt.run({
        taskId,
        scheduleTime: input.scheduleTime,
        scheduleEnabled: input.scheduleEnabled ? 1 : 0,
        scheduleFrequency: frequency,
        scheduleDaysOfWeek: daysOfWeek ? daysOfWeek.join(',') : null,
        scheduleDayOfMonth: dayOfMonth,
      });
      const row = getByIdStmt.get(taskId);
      if (!row) throw new Error(`Failed to read back file_backup_task ${taskId} after updating its schedule.`);
      return toDomain(row);
    },
  };
}
