import type { Database } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { ScheduleFrequency } from '../../../types.js';
import type { FileBackupTask } from '../../types.js';

interface FileBackupTaskRow {
  id: string;
  client_id: string;
  repository_id: string;
  name: string;
  source_kind: string;
  source_path: string;
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
}

export interface SetFileBackupScheduleInput {
  scheduleTime: string | null;
  scheduleEnabled: boolean;
  scheduleFrequency?: ScheduleFrequency;
  scheduleDaysOfWeek?: number[] | null;
  scheduleDayOfMonth?: number | null;
}

/** `sourceKind`/`sourcePath`/`repositoryId` are deliberately not editable — create a new task to point at a different folder. */
export interface UpdateFileBackupTaskInput {
  name?: string;
  retentionCount?: number | null;
  retentionDays?: number | null;
}

const SCHEDULE_TIME_FORMAT = /^([01]\d|2[0-3]):[0-5]\d$/;
const ABSOLUTE_WINDOWS_PATH = /^[A-Za-z]:\\/;

export interface FileBackupTasksRepo {
  createLocalFolder(input: CreateLocalFolderTaskInput): FileBackupTask;
  update(id: string, patch: UpdateFileBackupTaskInput): FileBackupTask;
  deactivate(id: string): void;
  reactivate(id: string): void;
  getById(id: string): FileBackupTask | null;
  listByClient(clientId: string): FileBackupTask[];
  listByRepository(repositoryId: string): FileBackupTask[];
  /** Every active task with a schedule configured and enabled — what file-task run-due iterates over. */
  listScheduled(): FileBackupTask[];
  setSchedule(taskId: string, input: SetFileBackupScheduleInput): FileBackupTask;
}

export function createFileBackupTasksRepo(db: Database): FileBackupTasksRepo {
  const insertStmt = db.prepare(
    `INSERT INTO file_backup_tasks
       (id, client_id, repository_id, name, source_kind, source_path, retention_count, retention_days)
     VALUES
       (@id, @clientId, @repositoryId, @name, 'local_folder', @sourcePath, @retentionCount, @retentionDays)`
  );
  const getByIdStmt = db.prepare<[string], FileBackupTaskRow>('SELECT * FROM file_backup_tasks WHERE id = ?');
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
     SET name = @name, retention_count = @retentionCount, retention_days = @retentionDays,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = @id`
  );
  const deactivateStmt = db.prepare(
    `UPDATE file_backup_tasks SET is_active = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
  );
  const reactivateStmt = db.prepare(
    `UPDATE file_backup_tasks SET is_active = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
  );

  return {
    createLocalFolder(input) {
      if (!ABSOLUTE_WINDOWS_PATH.test(input.sourcePath)) {
        throw new Error(`sourcePath must be an absolute Windows path (e.g. "D:\\Uploads"); got "${input.sourcePath}".`);
      }
      const id = randomUUID();
      insertStmt.run({
        id,
        clientId: input.clientId,
        repositoryId: input.repositoryId,
        name: input.name,
        sourcePath: input.sourcePath,
        retentionCount: input.retentionCount ?? null,
        retentionDays: input.retentionDays ?? null,
      });
      const row = getByIdStmt.get(id);
      if (!row) throw new Error(`Failed to read back created file_backup_task ${id}`);
      return toDomain(row);
    },

    update(id, patch) {
      const current = getByIdStmt.get(id);
      if (!current) throw new Error(`File-backup task ${id} not found.`);
      updateStmt.run({
        id,
        name: patch.name ?? current.name,
        retentionCount: patch.retentionCount !== undefined ? patch.retentionCount : current.retention_count,
        retentionDays: patch.retentionDays !== undefined ? patch.retentionDays : current.retention_days,
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
