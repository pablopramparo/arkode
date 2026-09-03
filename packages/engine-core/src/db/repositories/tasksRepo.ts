import type { Database } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { BackupTask, DbEngine, RemoteDumpExecMode, ScheduleFrequency } from '../../types.js';
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
  remote_dump_exec_mode: string;
  docker_container: string | null;
  remote_dump_database: string | null;
  remote_dump_db_user: string | null;
  remote_dump_db_password_secret_ref: string | null;
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
  backup_set_id: string | null;
  windows_task_name: string | null;
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
    remoteDumpExecMode: row.remote_dump_exec_mode as RemoteDumpExecMode,
    dockerContainer: row.docker_container,
    remoteDumpDatabase: row.remote_dump_database,
    remoteDumpDbUser: row.remote_dump_db_user,
    remoteDumpDbPasswordSecretRef: row.remote_dump_db_password_secret_ref,
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
    backupSetId: row.backup_set_id,
    windowsTaskName: row.windows_task_name,
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
  backupSetId?: string | null;
}

export interface CreateRemoteDumpTaskInput {
  clientId: string;
  transportId: string;
  name: string;
  dbEngine: DbEngine;
  /** Required (and the only thing that matters) for execMode 'host' (the default); ignored for 'docker', which builds its own command instead. */
  remoteCommand?: string;
  remoteOutputPathTemplate: string;
  remoteCleanup?: boolean;
  scheduleTime?: string | null;
  retentionCount?: number | null;
  retentionDays?: number | null;
  backupSetId?: string | null;
  /** Defaults to 'host' — every existing remote_dump task is implicitly this mode. */
  remoteDumpExecMode?: RemoteDumpExecMode;
  /** Required for execMode 'docker'; unused for 'host'. */
  dockerContainer?: string;
  /** Required for execMode 'docker'; unused for 'host'. */
  remoteDumpDatabase?: string;
  /** Required for execMode 'docker'; unused for 'host'. */
  remoteDumpDbUser?: string;
  /** Optional even for execMode 'docker' — e.g. a Postgres container commonly needs no password. Unused for 'host'. */
  remoteDumpDbPasswordSecretRef?: string | null;
}

export interface CreateDirectDumpTaskInput {
  clientId: string;
  databaseConnectionId: string;
  name: string;
  dbEngine: DbEngine;
  scheduleTime?: string | null;
  retentionCount?: number | null;
  retentionDays?: number | null;
  backupSetId?: string | null;
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

/**
 * `strategy`/`transportId`/`databaseConnectionId`/`dbEngine` are deliberately
 * not editable — they determine which downstream pipeline runs; create a
 * new task to change any of them. `backupSetId` is the one exception to
 * that immutability rule: unlike those, which task belongs to isn't a
 * pipeline-determining decision — pass `null` to explicitly un-assign.
 *
 * The remote-* pipeline detail fields (moved onto the task by migration
 * 0008) are a second, narrower exception: editable ONLY while the task has
 * no real backup yet — no `Success`/`Warning` run with a file on disk.
 * `update()` throws if any of them is present in the patch once a real
 * backup exists. They're the fix for "I created the task with the wrong
 * command and now I'm stuck." Which fields apply depends on the task's
 * (immutable) strategy: `fetch_existing` owns `remotePath`/
 * `remoteFilePattern`; `remote_dump` owns `remoteCommand` (host exec mode
 * only), `remoteOutputPathTemplate` and `remoteCleanup`; `direct_dump` has
 * none (passing any is rejected). Docker-mode structured fields
 * (dockerContainer/etc.) and secrets are deliberately still immutable here.
 */
export interface UpdateTaskInput {
  name?: string;
  retentionCount?: number | null;
  retentionDays?: number | null;
  backupSetId?: string | null;
  remotePath?: string | null;
  remoteFilePattern?: string | null;
  remoteCommand?: string | null;
  remoteOutputPathTemplate?: string | null;
  remoteCleanup?: boolean;
}

const PIPELINE_PATCH_KEYS = [
  'remotePath',
  'remoteFilePattern',
  'remoteCommand',
  'remoteOutputPathTemplate',
  'remoteCleanup',
] as const satisfies readonly (keyof UpdateTaskInput)[];

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
  /**
   * Records (or clears, with null) the exact Windows Scheduled Task name
   * this task is registered under — called only by a successful
   * scheduler:install/:uninstall, never by anything else. See
   * BackupTask.windowsTaskName's own doc comment for why this is stored
   * instead of recomputed.
   */
  setWindowsTaskName(taskId: string, windowsTaskName: string | null): BackupTask;
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
        remote_dump_exec_mode, docker_container, remote_dump_database, remote_dump_db_user, remote_dump_db_password_secret_ref,
        retention_count, retention_days, backup_set_id)
     VALUES
       (@id, @clientId, @strategy, @transportId, @databaseConnectionId, @name, @dbEngine,
        @remotePath, @remoteFilePattern, @remoteCommand, @remoteOutputPathTemplate, @remoteCleanup,
        @remoteDumpExecMode, @dockerContainer, @remoteDumpDatabase, @remoteDumpDbUser, @remoteDumpDbPasswordSecretRef,
        @retentionCount, @retentionDays, @backupSetId)`
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
     SET name = @name, retention_count = @retentionCount, retention_days = @retentionDays, backup_set_id = @backupSetId,
         remote_path = @remotePath, remote_file_pattern = @remoteFilePattern,
         remote_command = @remoteCommand, remote_output_path_template = @remoteOutputPathTemplate,
         remote_cleanup = @remoteCleanup,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = @id`
  );
  // Mirrors runsRepo's `listBackups` WHERE clause — "a real backup" is a
  // Success/Warning run that actually left a file on disk (a no-op or a
  // Failed attempt is not one, so a task whose only runs failed can still
  // have its remote command fixed — that's the whole point).
  const hasRealBackupStmt = db.prepare<[string], { total: number }>(
    `SELECT COUNT(*) AS total FROM backup_runs
     WHERE task_id = ? AND status IN ('Success','Warning') AND local_path IS NOT NULL`
  );
  const setWindowsTaskNameStmt = db.prepare(
    `UPDATE backup_tasks SET windows_task_name = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
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
      remoteDumpExecMode?: RemoteDumpExecMode;
      dockerContainer?: string | null;
      remoteDumpDatabase?: string | null;
      remoteDumpDbUser?: string | null;
      remoteDumpDbPasswordSecretRef?: string | null;
      retentionCount?: number | null;
      retentionDays?: number | null;
      backupSetId?: string | null;
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
      remoteDumpExecMode: input.remoteDumpExecMode ?? 'host',
      dockerContainer: input.dockerContainer ?? null,
      remoteDumpDatabase: input.remoteDumpDatabase ?? null,
      remoteDumpDbUser: input.remoteDumpDbUser ?? null,
      remoteDumpDbPasswordSecretRef: input.remoteDumpDbPasswordSecretRef ?? null,
      retentionCount: input.retentionCount ?? null,
      retentionDays: input.retentionDays ?? null,
      backupSetId: input.backupSetId ?? null,
    });
    const row = getByIdStmt.get(id);
    if (!row) throw new Error(`Failed to read back created backup task ${id}`);
    return toDomain(row);
  }

  function validateRemoteDumpInput(input: CreateRemoteDumpTaskInput): void {
    const mode = input.remoteDumpExecMode ?? 'host';
    if (mode === 'host') {
      if (!input.remoteCommand) {
        throw new Error('remote_dump tasks with execMode "host" require remoteCommand.');
      }
      return;
    }
    // mode === 'docker'
    if (!input.dockerContainer || !input.remoteDumpDatabase || !input.remoteDumpDbUser) {
      throw new Error('remote_dump tasks with execMode "docker" require dockerContainer, remoteDumpDatabase, and remoteDumpDbUser.');
    }
    if (input.dbEngine === 'unknown') {
      throw new Error('remote_dump tasks with execMode "docker" require a specific dbEngine (postgres, mysql, or mariadb) — the dump wrapper dispatches by it.');
    }
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
    if (strategy === 'remote_dump') {
      validateRemoteDumpInput(input as CreateRemoteDumpTaskInput);
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

      const touchesPipeline = PIPELINE_PATCH_KEYS.some((k) => patch[k] !== undefined);

      // Resolve the effective remote-* values (patch value if given, else
      // current). Trim strings; an emptied optional field becomes NULL.
      const resolveText = (patched: string | null | undefined, currentValue: string | null): string | null => {
        if (patched === undefined) return currentValue;
        const trimmed = (patched ?? '').trim();
        return trimmed === '' ? null : trimmed;
      };
      const remotePath = resolveText(patch.remotePath, current.remote_path);
      const remoteFilePattern = resolveText(patch.remoteFilePattern, current.remote_file_pattern);
      const remoteCommand = resolveText(patch.remoteCommand, current.remote_command);
      const remoteOutputPathTemplate = resolveText(patch.remoteOutputPathTemplate, current.remote_output_path_template);
      const remoteCleanup = patch.remoteCleanup !== undefined ? (patch.remoteCleanup ? 1 : 0) : current.remote_cleanup;

      if (touchesPipeline) {
        const strategy = current.strategy as BackupTask['strategy'];
        if (strategy === 'direct_dump') {
          throw new Error('direct_dump tasks have no remote command / path fields to edit.');
        }
        if (hasRealBackupStmt.get(id)!.total > 0) {
          throw new Error(
            "This task already has real backups, so its remote command / output-path template / remote path can't be changed anymore. Create a new task instead."
          );
        }
        if (strategy === 'fetch_existing') {
          if (patch.remoteCommand !== undefined || patch.remoteOutputPathTemplate !== undefined) {
            throw new Error('fetch_existing tasks have no remote command / output-path template.');
          }
          if (!remotePath) throw new Error('fetch_existing tasks require a remote path.');
        } else {
          // remote_dump
          if (patch.remotePath !== undefined || patch.remoteFilePattern !== undefined) {
            throw new Error('remote_dump tasks have no remote path / file pattern.');
          }
          if (!remoteOutputPathTemplate) {
            throw new Error('remote_dump tasks require a remote output path template.');
          }
          const execMode = current.remote_dump_exec_mode as RemoteDumpExecMode;
          if (execMode === 'host') {
            if (!remoteCommand) {
              throw new Error('remote_dump tasks with execMode "host" require a remote command.');
            }
          } else if (patch.remoteCommand != null && patch.remoteCommand.trim() !== '') {
            throw new Error("remote_dump tasks with execMode \"docker\" build their own command — remoteCommand can't be set.");
          }
        }
      }

      updateStmt.run({
        id,
        name: patch.name ?? current.name,
        retentionCount: patch.retentionCount !== undefined ? patch.retentionCount : current.retention_count,
        retentionDays: patch.retentionDays !== undefined ? patch.retentionDays : current.retention_days,
        backupSetId: patch.backupSetId !== undefined ? patch.backupSetId : current.backup_set_id,
        remotePath,
        remoteFilePattern,
        remoteCommand,
        remoteOutputPathTemplate,
        remoteCleanup,
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

    setWindowsTaskName(taskId, windowsTaskName) {
      const existing = getByIdStmt.get(taskId);
      if (!existing) throw new Error(`Task ${taskId} not found.`);
      setWindowsTaskNameStmt.run(windowsTaskName, taskId);
      const row = getByIdStmt.get(taskId);
      if (!row) throw new Error(`Failed to read back task ${taskId} after updating its Windows task name.`);
      return toDomain(row);
    },
  };
}
