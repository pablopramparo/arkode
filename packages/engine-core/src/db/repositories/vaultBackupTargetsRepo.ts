import type { Database } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

export type VaultBackupTargetKind = 'local_dir' | 'google_drive';

export interface VaultBackupTarget {
  id: string;
  kind: VaultBackupTargetKind;
  /** local_dir only — an absolute directory on this machine. */
  path: string | null;
  /** google_drive only — destination folder inside the Drive account, e.g. "Arkode/Vault". */
  remotePath: string | null;
  /**
   * google_drive only — Tier-1 DPAPI SecretStore ref to the RcloneDriveConfig
   * JSON. Present from creation; the secret itself is absent until the
   * account is authorized (mirrors replication_targets' "NULL-authorized" state).
   */
  rcloneConfigSecretRef: string | null;
  /** google_drive only — display label (e.g. the connected account e-mail). */
  label: string | null;
  retentionCount: number | null;
  enabled: boolean;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface VaultBackupRun {
  id: string;
  targetId: string;
  status: 'Success' | 'Failed';
  filePath: string | null;
  sizeBytes: number | null;
  startedAt: string;
  finishedAt: string | null;
  errorMessage: string | null;
  createdAt: string;
}

interface TargetRow {
  id: string;
  kind: string;
  path: string | null;
  remote_path: string | null;
  rclone_config_secret_ref: string | null;
  label: string | null;
  retention_count: number | null;
  enabled: number;
  last_run_at: string | null;
  last_status: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}
interface RunRow {
  id: string;
  target_id: string;
  status: string;
  file_path: string | null;
  size_bytes: number | null;
  started_at: string;
  finished_at: string | null;
  error_message: string | null;
  created_at: string;
}

const toTarget = (r: TargetRow): VaultBackupTarget => ({
  id: r.id,
  kind: r.kind as VaultBackupTargetKind,
  path: r.path,
  remotePath: r.remote_path,
  rcloneConfigSecretRef: r.rclone_config_secret_ref,
  label: r.label,
  retentionCount: r.retention_count,
  enabled: r.enabled === 1,
  lastRunAt: r.last_run_at,
  lastStatus: r.last_status,
  lastError: r.last_error,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
const toRun = (r: RunRow): VaultBackupRun => ({
  id: r.id,
  targetId: r.target_id,
  status: r.status as 'Success' | 'Failed',
  filePath: r.file_path,
  sizeBytes: r.size_bytes,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  errorMessage: r.error_message,
  createdAt: r.created_at,
});

export interface CreateLocalDirTargetInput {
  path: string;
  retentionCount?: number | null;
  enabled?: boolean;
}
export interface CreateGoogleDriveTargetInput {
  remotePath: string;
  label?: string | null;
  retentionCount?: number | null;
  enabled?: boolean;
}

export interface UpdateVaultBackupTargetInput {
  path?: string;
  remotePath?: string;
  label?: string | null;
  retentionCount?: number | null;
  enabled?: boolean;
}

export interface VaultBackupTargetsRepo {
  /** Back-compat: creates a local_dir target (the only kind before 0022). */
  create(input: CreateLocalDirTargetInput): VaultBackupTarget;
  createGoogleDrive(input: CreateGoogleDriveTargetInput): VaultBackupTarget;
  update(id: string, patch: UpdateVaultBackupTargetInput): VaultBackupTarget;
  remove(id: string): void;
  getById(id: string): VaultBackupTarget | null;
  list(): VaultBackupTarget[];
  listEnabled(): VaultBackupTarget[];
  recordResult(id: string, status: 'Success' | 'Failed', error: string | null): void;
  recordRun(input: Omit<VaultBackupRun, 'id' | 'createdAt'>): VaultBackupRun;
  listRecentRuns(limit?: number): VaultBackupRun[];
}

/** Deterministic-from-id so re-authorizing a Drive target overwrites its token in place. */
export function vaultBackupTargetConfigRef(id: string): string {
  return `vault-backup-target:${id}:rclone-config`;
}

export function createVaultBackupTargetsRepo(db: Database): VaultBackupTargetsRepo {
  const insertLocalStmt = db.prepare(
    `INSERT INTO vault_backup_targets (id, kind, path, retention_count, enabled)
     VALUES (@id, 'local_dir', @path, @retentionCount, @enabled)`
  );
  const insertDriveStmt = db.prepare(
    `INSERT INTO vault_backup_targets (id, kind, remote_path, rclone_config_secret_ref, label, retention_count, enabled)
     VALUES (@id, 'google_drive', @remotePath, @rcloneConfigSecretRef, @label, @retentionCount, @enabled)`
  );
  const getByIdStmt = db.prepare<[string], TargetRow>('SELECT * FROM vault_backup_targets WHERE id = ?');
  const listStmt = db.prepare<[], TargetRow>('SELECT * FROM vault_backup_targets ORDER BY created_at');
  const listEnabledStmt = db.prepare<[], TargetRow>(
    'SELECT * FROM vault_backup_targets WHERE enabled = 1 ORDER BY created_at'
  );
  const removeStmt = db.prepare('DELETE FROM vault_backup_targets WHERE id = ?');
  const recordResultStmt = db.prepare(
    `UPDATE vault_backup_targets
       SET last_run_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), last_status = @status, last_error = @error,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = @id`
  );
  const insertRunStmt = db.prepare(
    `INSERT INTO vault_backup_runs (id, target_id, status, file_path, size_bytes, started_at, finished_at, error_message)
     VALUES (@id, @targetId, @status, @filePath, @sizeBytes, @startedAt, @finishedAt, @errorMessage)`
  );
  const getRunStmt = db.prepare<[string], RunRow>('SELECT * FROM vault_backup_runs WHERE id = ?');
  const listRunsStmt = db.prepare<[number], RunRow>(
    'SELECT * FROM vault_backup_runs ORDER BY started_at DESC LIMIT ?'
  );

  return {
    create(input) {
      const id = randomUUID();
      insertLocalStmt.run({
        id,
        path: input.path,
        retentionCount: input.retentionCount ?? null,
        enabled: input.enabled === false ? 0 : 1,
      });
      return toTarget(getByIdStmt.get(id)!);
    },
    createGoogleDrive(input) {
      const id = randomUUID();
      insertDriveStmt.run({
        id,
        remotePath: input.remotePath,
        rcloneConfigSecretRef: vaultBackupTargetConfigRef(id),
        label: input.label ?? null,
        retentionCount: input.retentionCount ?? null,
        enabled: input.enabled === false ? 0 : 1,
      });
      return toTarget(getByIdStmt.get(id)!);
    },
    update(id, patch) {
      const current = getByIdStmt.get(id);
      if (!current) throw new Error(`Vault backup target ${id} not found.`);
      const sets: string[] = [];
      const params: Record<string, unknown> = { id };
      if (patch.path !== undefined) {
        sets.push('path = @path');
        params.path = patch.path;
      }
      if (patch.remotePath !== undefined) {
        sets.push('remote_path = @remotePath');
        params.remotePath = patch.remotePath;
      }
      if (patch.label !== undefined) {
        sets.push('label = @label');
        params.label = patch.label;
      }
      if (patch.retentionCount !== undefined) {
        sets.push('retention_count = @retentionCount');
        params.retentionCount = patch.retentionCount;
      }
      if (patch.enabled !== undefined) {
        sets.push('enabled = @enabled');
        params.enabled = patch.enabled ? 1 : 0;
      }
      if (sets.length > 0) {
        sets.push(`updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`);
        db.prepare(`UPDATE vault_backup_targets SET ${sets.join(', ')} WHERE id = @id`).run(params);
      }
      return toTarget(getByIdStmt.get(id)!);
    },
    remove(id) {
      removeStmt.run(id);
    },
    getById(id) {
      const r = getByIdStmt.get(id);
      return r ? toTarget(r) : null;
    },
    list() {
      return listStmt.all().map(toTarget);
    },
    listEnabled() {
      return listEnabledStmt.all().map(toTarget);
    },
    recordResult(id, status, error) {
      recordResultStmt.run({ id, status, error });
    },
    recordRun(input) {
      const id = randomUUID();
      insertRunStmt.run({
        id,
        targetId: input.targetId,
        status: input.status,
        filePath: input.filePath,
        sizeBytes: input.sizeBytes,
        startedAt: input.startedAt,
        finishedAt: input.finishedAt,
        errorMessage: input.errorMessage,
      });
      return toRun(getRunStmt.get(id)!);
    },
    listRecentRuns(limit = 50) {
      return listRunsStmt.all(limit).map(toRun);
    },
  };
}
