import type { Database } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { BackupTask, DbEngine } from '../../types.js';
import type { TransportsRepo } from './transportsRepo.js';

interface BackupTaskRow {
  id: string;
  client_id: string;
  strategy: string;
  transport_id: string | null;
  database_connection_id: string | null;
  name: string;
  db_engine: string;
  schedule_time: string | null;
  schedule_enabled: number;
  retention_count: number | null;
  retention_days: number | null;
  is_active: number;
  created_at: string;
  updated_at: string;
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
    scheduleTime: row.schedule_time,
    scheduleEnabled: row.schedule_enabled === 1,
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
  scheduleTime?: string | null;
}

export interface CreateRemoteDumpTaskInput {
  clientId: string;
  transportId: string;
  name: string;
  dbEngine: DbEngine;
  scheduleTime?: string | null;
}

export interface TasksRepo {
  createFetchExisting(input: CreateFetchExistingTaskInput): BackupTask;
  createRemoteDump(input: CreateRemoteDumpTaskInput): BackupTask;
  getById(id: string): BackupTask | null;
  listByClient(clientId: string): BackupTask[];
}

export function createTasksRepo(db: Database, transportsRepo: TransportsRepo): TasksRepo {
  const insertStmt = db.prepare(
    `INSERT INTO backup_tasks (id, client_id, strategy, transport_id, name, db_engine)
     VALUES (@id, @clientId, @strategy, @transportId, @name, @dbEngine)`
  );
  const getByIdStmt = db.prepare<[string], BackupTaskRow>('SELECT * FROM backup_tasks WHERE id = ?');
  const listByClientStmt = db.prepare<[string], BackupTaskRow>(
    'SELECT * FROM backup_tasks WHERE client_id = ? ORDER BY name'
  );

  function insertTransportBackedTask(
    strategy: 'fetch_existing' | 'remote_dump',
    requiredTransportType: 'sftp' | 'ssh',
    input: CreateFetchExistingTaskInput | CreateRemoteDumpTaskInput
  ): BackupTask {
    // App-level invariant the schema's CHECK can't express across tables:
    // each strategy requires a specific transport type.
    const transport = transportsRepo.getById(input.transportId);
    if (!transport) {
      throw new Error(`Transport ${input.transportId} not found.`);
    }
    if (transport.type !== requiredTransportType) {
      throw new Error(
        `${strategy} tasks require a ${requiredTransportType} transport; transport ${input.transportId} is "${transport.type}".`
      );
    }

    const id = randomUUID();
    insertStmt.run({
      id,
      clientId: input.clientId,
      strategy,
      transportId: input.transportId,
      name: input.name,
      dbEngine: input.dbEngine,
    });
    const row = getByIdStmt.get(id);
    if (!row) throw new Error(`Failed to read back created backup task ${id}`);
    return toDomain(row);
  }

  return {
    createFetchExisting(input) {
      return insertTransportBackedTask('fetch_existing', 'sftp', input);
    },

    createRemoteDump(input) {
      return insertTransportBackedTask('remote_dump', 'ssh', input);
    },

    getById(id) {
      const row = getByIdStmt.get(id);
      return row ? toDomain(row) : null;
    },

    listByClient(clientId) {
      return listByClientStmt.all(clientId).map(toDomain);
    },
  };
}
