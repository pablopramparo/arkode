import type { Database } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { BackupTask, DbEngine, ScheduleFrequency } from '../../types.js';
import type { TransportsRepo } from './transportsRepo.js';
import type { DatabaseConnectionsRepo } from './databaseConnectionsRepo.js';

interface BackupTaskRow {
  id: string;
  client_id: string;
  strategy: string;
  transport_id: string | null;
  database_connection_id: string | null;
  name: string;
  db_engine: string;
  remote_path: string | null;
  remote_file_pattern: string | null;
  remote_command: string | null;
  remote_output_path_template: string | null;
  remote_cleanup: number;
  schedule_time: string | null;
  schedule_enabled: number;
  schedule_frequency: string;
  schedule_days_of_week: string | null;
  schedule_day_of_month: number | null;
  retention_count: number | null;
  retention_days: number | null;
  is_active: number;
  created_at: string;
  updated_at: string;
}

function parseDaysOfWeek(csv: string | null): number[] | null {
  if (!csv) return null;
  return csv.split(',').map(Number);
}

function toDomain(row: BackupTaskRow): BackupTask {
  return {
    id: row.id,
    clientId: row.client_id,
    strategy: row.strategy as BackupTask['strategy'],
    transportId: row.transport_id,
    databaseConnectionId: row.database_connection_id,
    name: row.name,
    dbEngine: row.db_engine as DbEngine,
    remotePath: row.remote_path,
    remoteFilePattern: row.remote_file_pattern,
    remoteCommand: row.remote_command,
    remoteOutputPathTemplate: row.remote_output_path_template,
    remoteCleanup: row.remote_cleanup === 1,
    scheduleTime: row.schedule_time,
    scheduleEnabled: row.schedule_enabled === 1,
    scheduleFrequency: row.schedule_frequency as ScheduleFrequency,
    scheduleDaysOfWeek: parseDaysOfWeek(row.schedule_days_of_week),
    scheduleDayOfMonth: row.schedule_day_of_month,
    retentionCount: row.retention_count,
    retentionDays: row.retention_days,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateFetchExistingTaskInput {
  clientId: string;
  transportId: string;
  name: string;
  dbEngine: DbEngine;
  remotePath: string;
  remoteFilePattern?: string | null;
  scheduleTime?: string | null;
  retentionCount?: number | null;
  retentionDays?: number | null;
}

export interface CreateRemoteDumpTaskInput {
  clientId: string;
  transportId: string;
  name: string;
  dbEngine: DbEngine;
  remoteCommand: string;
  remoteOutputPathTemplate: string;
  remoteCleanup?: boolean;
  scheduleTime?: string | null;
  retentionCount?: number | null;
  retentionDays?: number | null;
}

export interface CreateDirectDumpTaskInput {
  clientId: string;
  databaseConnectionId: string;
  name: string;
  dbEngine: DbEngine;
  scheduleTime?: string | null;
  retentionCount?: number | null;
  retentionDays?: number | null;
}

export interface SetScheduleInput {
  scheduleTime: string | null;
  scheduleEnabled: boolean;
  /** Defaults to the task's current frequency (or 'daily' if it has none yet) when omitted. */
  scheduleFrequency?: ScheduleFrequency;
  /** 0 (Sunday) through 6 (Saturday). Required (non-empty) when the resulting frequency is 'weekly'; ignored otherwise. */
  scheduleDaysOfWeek?: number[] | null;
  /** 1-31. Required when the resulting frequency is 'monthly'; ignored otherwise. */
  scheduleDayOfMonth?: number | null;
}

/** `strategy`/`transportId`/`databaseConnectionId`/`dbEngine` are deliberately not editable — they determine which downstream pipeline runs; create a new task to change any of them. */
export interface UpdateTaskInput {
  name?: string;
  retentionCount?: number | null;
  retentionDays?: number | null;
}

const SCHEDULE_TIME_FORMAT = /^([01]\d|2[0-3]):[0-5]\d$/;

export interface TasksRepo {
  createFetchExisting(input: CreateFetchExistingTaskInput): BackupTask;
  createRemoteDump(input: CreateRemoteDumpTaskInput): BackupTask;
  createDirectDump(input: CreateDirectDumpTaskInput): BackupTask;
  update(id: string, patch: UpdateTaskInput): BackupTask;
  deactivate(id: string): void;
  reactivate(id: string): void;
  getById(id: string): BackupTask | null;
  listByClient(clientId: string): BackupTask[];
  /** Every active task with a schedule configured and enabled — what run-due iterates over. */
  listScheduled(): BackupTask[];
  setSchedule(taskId: string, input: SetScheduleInput): BackupTask;
}

export function createTasksRepo(
  db: Database,
  transportsRepo: TransportsRepo,
  databaseConnectionsRepo: DatabaseConnectionsRepo
): TasksRepo {
  const insertStmt = db.prepare(
    `INSERT INTO backup_tasks
       (id, client_id, strategy, transport_id, database_connection_id, name, db_engine,
        remote_path, remote_file_pattern, remote_command, remote_output_path_template, remote_cleanup,
        retention_count, retention_days)
     VALUES
       (@id, @clientId, @strategy, @transportId, @databaseConnectionId, @name, @dbEngine,
        @remotePath, @remoteFilePattern, @remoteCommand, @remoteOutputPathTemplate, @remoteCleanup,
        @retentionCount, @retentionDays)`
  );
  const getByIdStmt = db.prepare<[string], BackupTaskRow>('SELECT * FROM backup_tasks WHERE id = ?');
  const listByClientStmt = db.prepare<[string], BackupTaskRow>(
    'SELECT * FROM backup_tasks WHERE client_id = ? ORDER BY name'
  );
  const listScheduledStmt = db.prepare<[], BackupTaskRow>(
    `SELECT * FROM backup_tasks WHERE is_active = 1 AND schedule_enabled = 1 AND schedule_time IS NOT NULL`
  );
  const setScheduleStmt = db.prepare(
    `UPDATE backup_tasks
     SET schedule_time = @scheduleTime, schedule_enabled = @scheduleEnabled,
         schedule_frequency = @scheduleFrequency, schedule_days_of_week = @scheduleDaysOfWeek,
         schedule_day_of_month = @scheduleDayOfMonth, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = @taskId`
  );
  const updateStmt = db.prepare(
    `UPDATE backup_tasks
     SET name = @name, retention_count = @retentionCount, retention_days = @retentionDays,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = @id`
  );
  const deactivateStmt = db.prepare(
    `UPDATE backup_tasks SET is_active = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
  );
  const reactivateStmt = db.prepare(
    `UPDATE backup_tasks SET is_active = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
  );

  function insertTask(
    strategy: BackupTask['strategy'],
    input: {
      clientId: string;
      name: string;
      dbEngine: DbEngine;
      remotePath?: string | null;
      remoteFilePattern?: string | null;
      remoteCommand?: string | null;
      remoteOutputPathTemplate?: string | null;
      remoteCleanup?: boolean;
      retentionCount?: number | null;
      retentionDays?: number | null;
    },
    transportId: string | null,
    databaseConnectionId: string | null
  ): BackupTask {
    const id = randomUUID();
    insertStmt.run({
      id,
      clientId: input.clientId,
      strategy,
      transportId,
      databaseConnectionId,
      name: input.name,
      dbEngine: input.dbEngine,
      remotePath: input.remotePath ?? null,
      remoteFilePattern: input.remoteFilePattern ?? null,
      remoteCommand: input.remoteCommand ?? null,
      remoteOutputPathTemplate: input.remoteOutputPathTemplate ?? null,
      remoteCleanup: input.remoteCleanup ? 1 : 0,
      retentionCount: input.retentionCount ?? null,
      retentionDays: input.retentionDays ?? null,
    });
    const row = getByIdStmt.get(id);
    if (!row) throw new Error(`Failed to read back created backup task ${id}`);
    return toDomain(row);
  }

  function insertTransportBackedTask(
    strategy: 'fetch_existing' | 'remote_dump',
    allowedTransportTypes: readonly ('sftp' | 'ssh' | 'ftp')[],
    input: CreateFetchExistingTaskInput | CreateRemoteDumpTaskInput
  ): BackupTask {
    // App-level invariant the schema's CHECK can't express across tables:
    // each strategy requires a specific transport type (or, for
    // fetch_existing, one of two -- sftp and ftp are both "connect, list,
    // download the newest match" protocols; remote_dump has no FTP
    // equivalent since FTP has no remote-command-execution concept).
    const transport = transportsRepo.getById(input.transportId);
    if (!transport) {
      throw new Error(`Transport ${input.transportId} not found.`);
    }
    if (!allowedTransportTypes.includes(transport.type)) {
      throw new Error(
        `${strategy} tasks require a ${allowedTransportTypes.join(' or ')} transport; transport ${input.transportId} is "${transport.type}".`
      );
    }

    return insertTask(strategy, input, input.transportId, null);
  }

  return {
    createFetchExisting(input) {
      return insertTransportBackedTask('fetch_existing', ['sftp', 'ftp'], input);
    },

    createRemoteDump(input) {
      return insertTransportBackedTask('remote_dump', ['ssh'], input);
    },

    createDirectDump(input) {
      const databaseConnection = databaseConnectionsRepo.getById(input.databaseConnectionId);
      if (!databaseConnection) {
        throw new Error(`Database connection ${input.databaseConnectionId} not found.`);
      }

      return insertTask('direct_dump', input, null, input.databaseConnectionId);
    },

    update(id, patch) {
      const current = getByIdStmt.get(id);
      if (!current) throw new Error(`Task ${id} not found.`);
      updateStmt.run({
        id,
        name: patch.name ?? current.name,
        retentionCount: patch.retentionCount !== undefined ? patch.retentionCount : current.retention_count,
        retentionDays: patch.retentionDays !== undefined ? patch.retentionDays : current.retention_days,
      });
      const row = getByIdStmt.get(id);
      if (!row) throw new Error(`Failed to read back updated task ${id}`);
      return toDomain(row);
    },

    deactivate(id) {
      const current = getByIdStmt.get(id);
      if (!current) throw new Error(`Task ${id} not found.`);
      deactivateStmt.run(id);
    },

    reactivate(id) {
      const current = getByIdStmt.get(id);
      if (!current) throw new Error(`Task ${id} not found.`);
      reactivateStmt.run(id);
    },

    getById(id) {
      const row = getByIdStmt.get(id);
      return row ? toDomain(row) : null;
    },

    listByClient(clientId) {
      return listByClientStmt.all(clientId).map(toDomain);
    },

    listScheduled() {
      return listScheduledStmt.all().map(toDomain);
    },

    setSchedule(taskId, input) {
      if (input.scheduleTime !== null && !SCHEDULE_TIME_FORMAT.test(input.scheduleTime)) {
        throw new Error(`Invalid schedule time "${input.scheduleTime}" — expected 24h "HH:MM".`);
      }
      const existing = getByIdStmt.get(taskId);
      if (!existing) throw new Error(`Task ${taskId} not found.`);

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
      if (!row) throw new Error(`Failed to read back task ${taskId} after updating its schedule.`);
      return toDomain(row);
    },
  };
}
