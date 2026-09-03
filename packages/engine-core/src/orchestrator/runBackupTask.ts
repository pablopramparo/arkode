import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { BackupRun, BackupTask, Client, DbEngine, RunTrigger } from '../types.js';
import type { ClientsRepo } from '../db/repositories/clientsRepo.js';
import type { TransportsRepo } from '../db/repositories/transportsRepo.js';
import type { DatabaseConnectionsRepo } from '../db/repositories/databaseConnectionsRepo.js';
import type { RunsRepo } from '../db/repositories/runsRepo.js';
import type { LogEventsRepo } from '../db/repositories/logEventsRepo.js';
import type { KnownHostsRepo } from '../db/repositories/knownHostsRepo.js';
import type { RetentionDeletionsRepo } from '../db/repositories/retentionDeletionsRepo.js';
import type { SettingsRepo } from '../db/repositories/settingsRepo.js';
import type { SecretStore } from '../secrets/types.js';
import { NoNewDumpAvailableError, type BackupStrategyExecutor } from '../strategies/types.js';
import { createFetchExistingExecutor } from '../strategies/fetchExistingExecutor.js';
import { createRemoteDumpExecutor } from '../strategies/remoteDumpExecutor.js';
import { createDirectDumpExecutor } from '../strategies/directDumpExecutor.js';
import type { DumpValidator } from '../validators/types.js';
import { createGenericValidator } from '../validators/genericValidator.js';
import { isStaleInProgressRun } from '../util/processIdentity.js';
import { createPostgresCustomValidator } from '../validators/postgresCustomValidator.js';
import { createMysqlDumpValidator } from '../validators/mysqlDumpValidator.js';
import { createRunLogger, type RunLogger } from '../logging/logger.js';
import { applyRetention, resolveRetentionPolicy } from '../retention/applyRetention.js';
import { makeProgressReporter, type ProgressSink } from '../progress/runProgress.js';

/** Roughly a day — a .part file older than this with no live owner is almost certainly orphaned. */
const ORPHANED_PART_FILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface RunBackupTaskDeps {
  clientsRepo: ClientsRepo;
  transportsRepo: TransportsRepo;
  databaseConnectionsRepo: DatabaseConnectionsRepo;
  runsRepo: RunsRepo;
  logEventsRepo: LogEventsRepo;
  knownHostsRepo: KnownHostsRepo;
  retentionDeletionsRepo: RetentionDeletionsRepo;
  secretStore: SecretStore;
  /** Only needed for direct_dump's postgres version-aware tool registry (see postgresToolRegistry.ts) — omit to keep today's single-PG_DUMP_PATH behavior exactly as-is. */
  settingsRepo?: SettingsRepo;
  onUnknownHost?: (presented: { keyType: string; fingerprintSha256: string }) => Promise<boolean>;
  /**
   * How this run was initiated. `runDueTasks` (the scheduler's entry point,
   * invoked by a Windows Scheduled Task via `engine-cli run-due`) forces
   * this to 'scheduled' for every run it starts; every other caller
   * ("Ejecutar ahora", task:run) leaves it undefined and the run is
   * recorded as 'manual'. isTaskDue() keys its "did the scheduled run
   * already happen today?" check off this, so a manual run during the day
   * never makes that day's scheduled run get skipped.
   */
  runTrigger?: RunTrigger;
  /**
   * Receives live progress updates while the run executes (see RunProgress).
   * Called as `onProgress(run.id, progress)` so a batch caller (runDueTasks)
   * can forward one sink to many runs. Optional — omitting it makes every
   * `reportProgress` call in the pipeline a no-op, exactly today's behaviour.
   */
  onProgress?: ProgressSink;
  /**
   * Overrides how the strategy executor is resolved. Production code never
   * sets this — it exists so tests can inject a fake BackupStrategyExecutor
   * and exercise the orchestrator's own logic (locking, checksum fallback,
   * retention wiring, status transitions) without a real transport or
   * database connection.
   */
  resolveExecutorOverride?: (task: BackupTask, deps: RunBackupTaskDeps) => BackupStrategyExecutor;
}

export interface RunBackupTaskResult {
  run: BackupRun;
  skipped: boolean;
}

async function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Recovers from a crash mid-run: any Running/Producing/Validating row that
 * `isStaleInProgressRun` judges dead (see that helper — a bare
 * `process.kill(pid, 0)` isn't enough, since a recycled PID would keep a
 * crashed run stuck forever) is marked Failed so it doesn't block the
 * app-level lock below.
 */
function recoverStaleRuns(runsRepo: RunsRepo, taskId: string): void {
  for (const run of runsRepo.listInProgress(taskId)) {
    if (!isStaleInProgressRun(run)) continue;
    runsRepo.markFinished(run.id, 'Failed', { errorMessage: 'Run interrupted: owning process is no longer alive.' });
  }
}

/**
 * Cleans up .part files left behind by an interrupted run. Not tied to a
 * specific run id (a Producing-status run has no local_path recorded yet) —
 * instead sweeps targetDir for stale partials by age.
 */
async function cleanupOrphanedPartFiles(targetDir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(targetDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const removed: string[] = [];
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.part')) continue;
    const fullPath = join(targetDir, entry.name);
    const fileStat = await stat(fullPath);
    if (now - fileStat.mtimeMs > ORPHANED_PART_FILE_MAX_AGE_MS) {
      await rm(fullPath, { force: true });
      removed.push(fullPath);
    }
  }
  return removed;
}

function slugify(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'task';
}

/**
 * Backups/{cliente}/{database}/{YYYY}/{MM}/ — the "{database}" segment isn't
 * a separate schema field for fetch_existing/remote_dump tasks (only
 * direct_dump has a real database name via database_connections), so the
 * task's own name stands in for it here.
 */
function resolveTargetDir(client: Client, task: BackupTask, now: Date = new Date()): string {
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return join(client.localBasePath, slugify(task.name), year, month);
}

function pickValidators(dbEngine: DbEngine): DumpValidator[] {
  const validators: DumpValidator[] = [createGenericValidator()];
  if (dbEngine === 'postgres') validators.push(createPostgresCustomValidator());
  // mariadb-dump writes the exact same "-- Dump completed on" completion
  // footer mysqldump does (confirmed by hand against a real local instance
  // of each) — one validator covers both engines.
  if (dbEngine === 'mysql' || dbEngine === 'mariadb') validators.push(createMysqlDumpValidator());
  return validators;
}

/**
 * Applies retention after every completed attempt, regardless of this run's
 * own outcome — an old Success backup can be past its policy even if today's
 * run just failed. Best-effort: a retention failure is logged, never
 * allowed to override this run's own already-recorded status.
 */
async function applyRetentionSafely(
  task: BackupTask,
  client: Client,
  deps: RunBackupTaskDeps,
  logger: RunLogger,
  triggeredByRunId: string
): Promise<void> {
  try {
    const policy = resolveRetentionPolicy(client, task);
    await applyRetention(task, policy, {
      runsRepo: deps.runsRepo,
      retentionDeletionsRepo: deps.retentionDeletionsRepo,
      logger,
      triggeredByRunId,
    });
  } catch (err) {
    logger.log('warn', 'retention', `Retention check failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Resolves the one executor this task actually needs. The orchestrator only
 * ever depends on BackupStrategyExecutor — adding remote_dump/direct_dump
 * later means adding a case here, not restructuring the pipeline below.
 */
function resolveExecutor(task: BackupTask, deps: RunBackupTaskDeps): BackupStrategyExecutor {
  switch (task.strategy) {
    case 'fetch_existing': {
      const transport = task.transportId ? deps.transportsRepo.getById(task.transportId) : null;
      if (!transport) {
        throw new Error(`Task ${task.id} has strategy fetch_existing but no valid transport configured.`);
      }
      return createFetchExistingExecutor(
        transport,
        deps.secretStore,
        deps.knownHostsRepo,
        deps.runsRepo,
        deps.onUnknownHost
      );
    }
    case 'remote_dump': {
      const transport = task.transportId ? deps.transportsRepo.getById(task.transportId) : null;
      if (!transport) {
        throw new Error(`Task ${task.id} has strategy remote_dump but no valid transport configured.`);
      }
      return createRemoteDumpExecutor(transport, deps.secretStore, deps.knownHostsRepo, deps.onUnknownHost);
    }
    case 'direct_dump': {
      const databaseConnection = task.databaseConnectionId
        ? deps.databaseConnectionsRepo.getById(task.databaseConnectionId)
        : null;
      if (!databaseConnection) {
        throw new Error(`Task ${task.id} has strategy direct_dump but no valid database connection configured.`);
      }
      return createDirectDumpExecutor(databaseConnection, deps.secretStore, deps.settingsRepo);
    }
  }
}

export async function runBackupTask(task: BackupTask, deps: RunBackupTaskDeps): Promise<RunBackupTaskResult> {
  recoverStaleRuns(deps.runsRepo, task.id);

  // App-level lock: WAL allows concurrent readers, not concurrent writers,
  // and a second Task-Scheduler/GUI-triggered run of the same task would
  // race the first. Skip rather than double-run.
  const stillInProgress = deps.runsRepo.listInProgress(task.id).filter((r) => !isStaleInProgressRun(r));
  if (stillInProgress.length > 0) {
    return { run: stillInProgress[0], skipped: true };
  }

  const client = deps.clientsRepo.getById(task.clientId);
  if (!client) throw new Error(`Client ${task.clientId} not found for task ${task.id}.`);

  const run = deps.runsRepo.create({
    taskId: task.id,
    clientId: task.clientId,
    strategy: task.strategy,
    transportId: task.transportId,
    databaseConnectionId: task.databaseConnectionId,
    pid: process.pid,
    trigger: deps.runTrigger,
  });

  const logger = createRunLogger(run.id, deps.logEventsRepo);
  const reportProgress = makeProgressReporter(run.id, deps.onProgress);
  logger.log('info', 'connect', `Starting ${task.strategy} run for task "${task.name}" (client "${client.name}").`);

  const targetDir = resolveTargetDir(client, task);
  await mkdir(targetDir, { recursive: true });

  const removedOrphans = await cleanupOrphanedPartFiles(targetDir);
  for (const path of removedOrphans) {
    logger.log('warn', 'recovery', `Removed orphaned partial file from a previous interrupted run: ${path}`);
  }

  try {
    deps.runsRepo.markProducing(run.id);
    logger.log('info', 'produce', `Producing dump via ${task.strategy}.`);
    reportProgress({ phase: 'connecting', fraction: null });

    const executor = deps.resolveExecutorOverride ? deps.resolveExecutorOverride(task, deps) : resolveExecutor(task, deps);
    const produced = await executor.produce({ task, client, targetDir, reportProgress });

    logger.log('info', 'download', `Produced ${produced.fileName} (${produced.sizeBytes} bytes) at ${produced.localTempPath}.`);

    if (produced.sizeBytes <= 0) {
      throw new Error(`Produced file "${produced.fileName}" is empty (0 bytes).`);
    }

    // Checksum responsibility split: use the strategy's streamed hash if it
    // provided one; otherwise hash the temp file once here as a fallback.
    if (!produced.checksumSha256) reportProgress({ phase: 'finalizing', fraction: null, label: 'Calculando checksum…' });
    const checksumSha256 = produced.checksumSha256 ?? (await hashFile(produced.localTempPath));

    const finalPath = produced.localTempPath.endsWith('.part')
      ? produced.localTempPath.slice(0, -'.part'.length)
      : produced.localTempPath;
    await rename(produced.localTempPath, finalPath);
    logger.log('info', 'download', `Renamed ${produced.localTempPath} -> ${finalPath} after successful transfer.`);

    deps.runsRepo.markValidating(run.id, {
      fileName: produced.fileName,
      sizeBytes: produced.sizeBytes,
      sourceModifiedAt: produced.sourceModifiedAt,
      checksumSha256,
      localPath: finalPath,
    });
    logger.log('info', 'validate', `Validating ${finalPath}.`);
    reportProgress({ phase: 'validating', fraction: null });

    const validators = pickValidators(task.dbEngine);
    const results = await Promise.all(validators.map((v) => v.validate(finalPath)));
    const allWarnings = results.flatMap((r) => r.warnings);
    const failed = results.find((r) => !r.valid);

    if (failed) {
      deps.runsRepo.markFinished(run.id, 'Failed', { errorMessage: failed.details ?? 'Validation failed.' });
      logger.log('error', 'result', `Validation failed: ${failed.details ?? 'unknown reason'}.`);
    } else if (allWarnings.length > 0) {
      deps.runsRepo.markFinished(run.id, 'Warning', { errorMessage: allWarnings.join('; ') });
      logger.log('warn', 'result', `Completed with warnings: ${allWarnings.join('; ')}.`);
    } else {
      deps.runsRepo.markFinished(run.id, 'Success');
      logger.log('info', 'result', `Backup succeeded: ${finalPath} (sha256 ${checksumSha256}).`);
    }

    await applyRetentionSafely(task, client, deps, logger, run.id);
    const finished = deps.runsRepo.getById(run.id);
    if (!finished) throw new Error(`Run ${run.id} vanished after completion — this should never happen.`);
    return { run: finished, skipped: false };
  } catch (err) {
    if (err instanceof NoNewDumpAvailableError) {
      // Not a failure: the spec explicitly requires never redundantly
      // re-downloading an already-validated backup. Record it as a
      // successful no-op, not an error a dashboard should flag red.
      deps.runsRepo.markFinished(run.id, 'Success');
      logger.log('info', 'result', `No new backup needed: ${err.message}`);
      await applyRetentionSafely(task, client, deps, logger, run.id);
      const finished = deps.runsRepo.getById(run.id);
      if (!finished) throw err;
      return { run: finished, skipped: true };
    }

    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    deps.runsRepo.markFinished(run.id, 'Failed', { errorMessage: message, errorStack: stack });
    logger.log('error', 'result', `Run failed: ${message}`);
    await applyRetentionSafely(task, client, deps, logger, run.id);
    const finished = deps.runsRepo.getById(run.id);
    if (!finished) throw err;
    return { run: finished, skipped: false };
  }
}
