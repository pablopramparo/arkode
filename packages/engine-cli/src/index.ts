#!/usr/bin/env node
import { Command } from 'commander';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { basename, resolve as resolvePath, join as joinPath } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  runBackupTask,
  createSftpAdapterFromTransport,
  createSshAdapterFromTransport,
  createFtpAdapterFromTransport,
  testDatabaseConnection,
  exportConfig,
  exportTask,
  importConfig,
  importTaskBundle,
  runDueTasks,
  runSchedulerTick,
  SCHEDULER_HEARTBEAT_KEY,
  schedulerServiceStatus,
  restartSchedulerService,
  reinstallSchedulerService,
  scheduledTaskNameForBackupTask,
  scheduledTaskDisplayName,
  installScheduledTask,
  uninstallScheduledTask,
  scheduledTaskStatus,
  listArkodeScheduledTaskNames,
  getDashboardStatus,
  getSystemInfo,
  getVaultStatus,
  VaultNotInitializedError,
  VaultAlreadyInitializedError,
  WrongMasterPasswordError,
  VaultLockedError,
  VaultAutoUnlockUnavailableError,
  VaultCryptoError,
  newCredentialSecretRef,
  normalizeCredentialSecret,
  writeCredentialSecret,
  readCredentialSecret,
  syncOperationalCopy,
  resyncOperationalCopies,
  type SyncOperationalCopyDeps,
  exportVaultBuffer,
  importVaultBuffer,
  inspectVaultBuffer,
  runAllVaultBackups,
  runDueVaultBackups,
  ArkvaultParseError,
  type RunVaultBackupDeps,
  detectInstalledDbTools,
  copyPrivateKeyIntoAppStorage,
  createPostgresToolRegistry,
  downloadTool,
  vendoredToolsDir,
  createMysqlToolRegistry,
  createMariaDbToolRegistry,
  testDirectDumpCompatibility,
  createFileBackupRepository,
  exportFileBackupRepositoryKey,
  runFileBackupTask,
  runFileBackupDueTasks,
  runFileBackupMaintenance,
  restoreFileBackupRun,
  restoreFileBackupFile,
  deleteBackupRun,
  deleteFileBackupRun,
  replicateTarget,
  resolveRcloneRemote,
  isReplicationDue,
  rcloneClient,
  hardenExistingKeyStore,
  scheduledTaskNameForBackupTask as scheduledTaskNameForId,
  type DbEngine,
  type Transport,
  type ConnectionTestResult,
  type ConfigExport,
  type ExportedTaskBundle,
  type RunBackupTaskDeps,
  type BackupTask,
  type DirectDumpCompatibilityResult,
  type RunFileBackupTaskDeps,
  type FileBackupTask,
  type FileBackupMaintenanceOperation,
  type ReplicateTargetDeps,
  type ReplicationDueDeps,
  type ReplicationContent,
  type ReplicationProvider,
  type RcloneDriveConfig,
  resticClient,
  redactSecrets,
  configurePocket,
  setPocketEnabled,
  generatePocketPairingPayload,
  revokePocketDevice,
  runPocketPublish,
  isPocketDriveConnected,
  getPocketDriveConfig,
  setPocketDriveToken,
  reusePocketDriveTokenFrom,
  disconnectPocketDrive,
  POCKET_RCLONE_CONFIG_SECRET_REF,
  vaultBackupTargetConfigRef,
  type RunPocketPublishDeps,
  type PocketState,
} from 'engine-core';
import { buildContext } from './context.js';
import { confirmHostInteractively } from './confirmHost.js';
import { promptPassword } from './promptPassword.js';

/** The scheduled-task naming helper only ever interpolates a bare id — reused unchanged for file-backup task ids under a distinct alias for readability at call sites. */
const scheduledTaskNameForFileBackupTask = scheduledTaskNameForId;
/** Fixed name for the one global maintenance sweep task (see runFileBackupMaintenance.ts) -- not per-task/per-client. */
const FILE_BACKUP_MAINTENANCE_TASK_NAME = '\\arkode\\file-backup-maintenance';

const program = new Command();
program.name('engine-cli').description('arkode engine CLI').version('0.0.0');

program
  .command('migrate')
  .description('Apply pending SQLite migrations.')
  .action(() => {
    buildContext(); // buildContext() itself runs migrations on open
    console.log('Migrations applied.');
  });

program
  .command('client:create')
  .description('Create a client.')
  .requiredOption('--name <name>')
  .requiredOption('--local-base-path <path>')
  .option('--description <description>')
  .option('--retention-count <n>', 'default retention policy for this client\'s tasks: keep the last N Success backups')
  .option('--retention-days <n>', 'default retention policy for this client\'s tasks: keep backups from the last N days')
  .action((opts) => {
    const ctx = buildContext();
    const client = ctx.clientsRepo.create({
      name: opts.name,
      description: opts.description ?? null,
      localBasePath: opts.localBasePath,
      retentionCount: opts.retentionCount != null ? Number(opts.retentionCount) : null,
      retentionDays: opts.retentionDays != null ? Number(opts.retentionDays) : null,
    });
    console.log(JSON.stringify(client, null, 2));
  });

program
  .command('client:list')
  .description('List clients (active only by default).')
  .option('--all', 'include deactivated clients too', false)
  .action((opts) => {
    const ctx = buildContext();
    console.log(JSON.stringify(opts.all ? ctx.clientsRepo.listAll() : ctx.clientsRepo.listActive(), null, 2));
  });

program
  .command('client:update')
  .description("Update a client's fields. Only the flags you pass are changed — everything else is left as-is.")
  .argument('<clientId>')
  .option('--name <name>')
  .option('--description <description>')
  .option('--clear-description', 'clear the description instead of setting one', false)
  .option('--local-base-path <path>')
  .option('--retention-count <n>')
  .option('--retention-days <n>')
  .action((clientId: string, opts) => {
    const ctx = buildContext();
    const client = ctx.clientsRepo.update(clientId, {
      name: opts.name,
      description: opts.clearDescription ? null : opts.description,
      localBasePath: opts.localBasePath,
      retentionCount: opts.retentionCount != null ? Number(opts.retentionCount) : undefined,
      retentionDays: opts.retentionDays != null ? Number(opts.retentionDays) : undefined,
    });
    console.log(JSON.stringify(client, null, 2));
  });

program
  .command('client:deactivate')
  .description('Deactivate a client. Its tasks stop appearing on the dashboard and in scheduling; nothing is deleted.')
  .argument('<clientId>')
  .action((clientId: string) => {
    const ctx = buildContext();
    ctx.clientsRepo.deactivate(clientId);
    console.log(`Deactivated client ${clientId}.`);
  });

program
  .command('client:reactivate')
  .description('Reactivate a previously deactivated client.')
  .argument('<clientId>')
  .action((clientId: string) => {
    const ctx = buildContext();
    ctx.clientsRepo.reactivate(clientId);
    console.log(`Reactivated client ${clientId}.`);
  });

program
  .command('backup-set:create')
  .description('Create a backup set — a pure visual/reporting label grouping several tasks under one name for a client. No shared schedule, no aggregate run.')
  .requiredOption('--client <clientId>')
  .requiredOption('--name <name>')
  .action((opts) => {
    const ctx = buildContext();
    const set = ctx.backupSetsRepo.create({ clientId: opts.client, name: opts.name });
    console.log(JSON.stringify(set, null, 2));
  });

program
  .command('backup-set:list')
  .description('List a client\'s backup sets (active only by default).')
  .requiredOption('--client <clientId>')
  .option('--include-inactive', 'include deactivated sets too', false)
  .action((opts) => {
    const ctx = buildContext();
    console.log(JSON.stringify(ctx.backupSetsRepo.listByClient(opts.client, { includeInactive: opts.includeInactive }), null, 2));
  });

program
  .command('backup-set:update')
  .description('Rename a backup set.')
  .argument('<backupSetId>')
  .requiredOption('--name <name>')
  .action((backupSetId: string, opts) => {
    const ctx = buildContext();
    console.log(JSON.stringify(ctx.backupSetsRepo.update(backupSetId, { name: opts.name }), null, 2));
  });

program
  .command('backup-set:deactivate')
  .description('Deactivate a backup set. Tasks assigned to it keep their assignment but the set stops appearing in "active sets" lists.')
  .argument('<backupSetId>')
  .action((backupSetId: string) => {
    const ctx = buildContext();
    ctx.backupSetsRepo.deactivate(backupSetId);
    console.log(`Deactivated backup set ${backupSetId}.`);
  });

program
  .command('backup-set:reactivate')
  .description('Reactivate a previously deactivated backup set.')
  .argument('<backupSetId>')
  .action((backupSetId: string) => {
    const ctx = buildContext();
    ctx.backupSetsRepo.reactivate(backupSetId);
    console.log(`Reactivated backup set ${backupSetId}.`);
  });

function resolveSecretRef(ctx: ReturnType<typeof buildContext>, value: string | undefined, refPrefix: string): string | null {
  if (!value) return null;
  const ref = `${refPrefix}:${randomUUID()}`;
  ctx.secretStore.set(ref, value);
  return ref;
}

function resolvePassphraseSecretRef(ctx: ReturnType<typeof buildContext>, passphrase: string | undefined): string | null {
  return resolveSecretRef(ctx, passphrase, 'transport:passphrase');
}

function resolveFtpPasswordSecretRef(ctx: ReturnType<typeof buildContext>, password: string | undefined): string | null {
  return resolveSecretRef(ctx, password, 'transport:password');
}

program
  .command('transport:create-sftp')
  .description('Create an SFTP transport for a client (fetch_existing strategy).')
  .requiredOption('--client <clientId>')
  .requiredOption('--name <name>')
  .requiredOption('--host <host>')
  .option('--port <port>', 'default 22', '22')
  .requiredOption('--username <username>')
  .requiredOption('--private-key-path <path>')
  .option('--passphrase <passphrase>', 'SSH key passphrase — stored via Windows Credential Manager, never in SQLite')
  .action(async (opts) => {
    const ctx = buildContext();
    const privateKeyPath = await copyPrivateKeyIntoAppStorage(opts.privateKeyPath);
    const transport = ctx.transportsRepo.createSftp({
      clientId: opts.client,
      name: opts.name,
      host: opts.host,
      port: Number(opts.port),
      username: opts.username,
      privateKeyPath,
      passphraseSecretRef: resolvePassphraseSecretRef(ctx, opts.passphrase),
    });
    console.log(JSON.stringify(transport, null, 2));
  });

program
  .command('transport:create-ssh')
  .description('Create an SSH transport for a client (remote_dump strategy).')
  .requiredOption('--client <clientId>')
  .requiredOption('--name <name>')
  .requiredOption('--host <host>')
  .option('--port <port>', 'default 22', '22')
  .requiredOption('--username <username>')
  .requiredOption('--private-key-path <path>')
  .option('--passphrase <passphrase>', 'SSH key passphrase — stored via Windows Credential Manager, never in SQLite')
  .action(async (opts) => {
    const ctx = buildContext();
    const privateKeyPath = await copyPrivateKeyIntoAppStorage(opts.privateKeyPath);
    const transport = ctx.transportsRepo.createSsh({
      clientId: opts.client,
      name: opts.name,
      host: opts.host,
      port: Number(opts.port),
      username: opts.username,
      privateKeyPath,
      passphraseSecretRef: resolvePassphraseSecretRef(ctx, opts.passphrase),
    });
    console.log(JSON.stringify(transport, null, 2));
  });

program
  .command('transport:create-ftp')
  .description('Create a plain-FTP transport for a client (fetch_existing strategy).')
  .requiredOption('--client <clientId>')
  .requiredOption('--name <name>')
  .requiredOption('--host <host>')
  .option('--port <port>', 'default 21', '21')
  .requiredOption('--username <username>')
  .option('--password <password>', 'FTP password — stored via Windows Credential Manager, never in SQLite; omit for anonymous FTP')
  .action((opts) => {
    const ctx = buildContext();
    const transport = ctx.transportsRepo.createFtp({
      clientId: opts.client,
      name: opts.name,
      host: opts.host,
      port: Number(opts.port),
      username: opts.username,
      passwordSecretRef: resolveFtpPasswordSecretRef(ctx, opts.password),
    });
    console.log(JSON.stringify(transport, null, 2));
  });

program
  .command('database-connection:create')
  .description('Create a direct DB connection for a client (direct_dump strategy).')
  .requiredOption('--client <clientId>')
  .requiredOption('--name <name>')
  .requiredOption('--engine <engine>', 'postgres | mysql')
  .requiredOption('--host <host>')
  .requiredOption('--port <port>')
  .requiredOption('--database <databaseName>')
  .requiredOption('--username <username>')
  .option('--password <password>', 'DB password — stored via Windows Credential Manager, never in SQLite')
  .option('--ssl-mode <sslMode>', 'disable | require | verify-full')
  .action((opts) => {
    const ctx = buildContext();
    const connection = ctx.databaseConnectionsRepo.create({
      clientId: opts.client,
      name: opts.name,
      engine: opts.engine,
      host: opts.host,
      port: Number(opts.port),
      databaseName: opts.database,
      username: opts.username,
      passwordSecretRef: resolveSecretRef(ctx, opts.password, 'databaseConnection:password'),
      sslMode: opts.sslMode ?? null,
    });
    console.log(JSON.stringify(connection, null, 2));
  });

program
  .command('transport:update')
  .description("Update a transport's fields (not its type — create a new one to switch sftp/ssh). Only the flags you pass are changed.")
  .argument('<transportId>')
  .option('--name <name>')
  .option('--host <host>')
  .option('--port <port>')
  .option('--username <username>')
  .option('--private-key-path <path>')
  .option('--passphrase <passphrase>', 'set a new SSH key passphrase — omit to leave the existing one untouched')
  .option('--password <password>', 'set a new FTP password — omit to leave the existing one untouched')
  .action(async (transportId: string, opts) => {
    const ctx = buildContext();
    const privateKeyPath = opts.privateKeyPath ? await copyPrivateKeyIntoAppStorage(opts.privateKeyPath) : undefined;
    const transport = ctx.transportsRepo.update(transportId, {
      name: opts.name,
      host: opts.host,
      port: opts.port != null ? Number(opts.port) : undefined,
      username: opts.username,
      privateKeyPath,
      passphraseSecretRef: opts.passphrase ? resolvePassphraseSecretRef(ctx, opts.passphrase) : undefined,
      passwordSecretRef: opts.password ? resolveFtpPasswordSecretRef(ctx, opts.password) : undefined,
    });
    console.log(JSON.stringify(transport, null, 2));
  });

program
  .command('transport:deactivate')
  .description('Deactivate a transport. Tasks referencing it will fail cleanly at run time rather than being deleted.')
  .argument('<transportId>')
  .action((transportId: string) => {
    const ctx = buildContext();
    ctx.transportsRepo.deactivate(transportId);
    console.log(`Deactivated transport ${transportId}.`);
  });

program
  .command('transport:reactivate')
  .description('Reactivate a previously deactivated transport.')
  .argument('<transportId>')
  .action((transportId: string) => {
    const ctx = buildContext();
    ctx.transportsRepo.reactivate(transportId);
    console.log(`Reactivated transport ${transportId}.`);
  });

program
  .command('database-connection:update')
  .description("Update a database connection's fields (not its engine — create a new one to switch postgres/mysql/mariadb). Only the flags you pass are changed.")
  .argument('<databaseConnectionId>')
  .option('--name <name>')
  .option('--host <host>')
  .option('--port <port>')
  .option('--database <databaseName>')
  .option('--username <username>')
  .option('--password <password>', 'set a new DB password — omit to leave the existing one untouched')
  .option('--ssl-mode <sslMode>', 'disable | require | verify-full')
  .action((databaseConnectionId: string, opts) => {
    const ctx = buildContext();
    const connection = ctx.databaseConnectionsRepo.update(databaseConnectionId, {
      name: opts.name,
      host: opts.host,
      port: opts.port != null ? Number(opts.port) : undefined,
      databaseName: opts.database,
      username: opts.username,
      passwordSecretRef: opts.password ? resolveSecretRef(ctx, opts.password, 'databaseConnection:password') : undefined,
      sslMode: opts.sslMode,
    });
    console.log(JSON.stringify(connection, null, 2));
  });

program
  .command('database-connection:deactivate')
  .description('Deactivate a database connection. Tasks referencing it will fail cleanly at run time rather than being deleted.')
  .argument('<databaseConnectionId>')
  .action((databaseConnectionId: string) => {
    const ctx = buildContext();
    ctx.databaseConnectionsRepo.deactivate(databaseConnectionId);
    console.log(`Deactivated database connection ${databaseConnectionId}.`);
  });

program
  .command('database-connection:reactivate')
  .description('Reactivate a previously deactivated database connection.')
  .argument('<databaseConnectionId>')
  .action((databaseConnectionId: string) => {
    const ctx = buildContext();
    ctx.databaseConnectionsRepo.reactivate(databaseConnectionId);
    console.log(`Reactivated database connection ${databaseConnectionId}.`);
  });

program
  .command('task:create')
  .description('Create a backup task (strategy determined by --strategy, matching the transport/database-connection type).')
  .requiredOption('--client <clientId>')
  .requiredOption('--name <name>')
  .option('--strategy <strategy>', 'fetch_existing | remote_dump | direct_dump', 'fetch_existing')
  .option('--transport <transportId>', 'required for fetch_existing/remote_dump')
  .option('--database-connection <databaseConnectionId>', 'required for direct_dump')
  .option('--db-engine <engine>', 'postgres | mysql | unknown', 'unknown')
  .option('--remote-path <path>', 'required for fetch_existing — the remote directory to look for a dump in')
  .option('--remote-file-pattern <regex>', 'fetch_existing only')
  .option('--remote-command <command>', 'required for remote_dump — command that produces the dump on the remote host')
  .option(
    '--remote-output-path-template <template>',
    'required for remote_dump — expected produced-file path, e.g. /tmp/backups/winners_{date:YYYYMMDD_HHmm}.dump'
  )
  .option('--remote-cleanup', 'remote_dump only: delete the remote file after a successful download', false)
  .option('--remote-dump-mode <host|docker>', 'remote_dump only: "host" (default) runs --remote-command directly; "docker" dumps a database running in a container instead', 'host')
  .option('--docker-container <nameOrId>', 'required for --remote-dump-mode docker — the container to docker exec into')
  .option('--remote-dump-database <name>', 'required for --remote-dump-mode docker — the database name inside the container')
  .option('--remote-dump-db-user <user>', 'required for --remote-dump-mode docker — the DB user to authenticate as inside the container')
  .option('--remote-dump-db-password <password>', 'optional for --remote-dump-mode docker — e.g. commonly unneeded for Postgres (trust/peer auth), usually needed for MySQL/MariaDB')
  .option('--retention-count <n>', 'override the client default: keep the last N Success backups for this task')
  .option('--retention-days <n>', 'override the client default: keep backups from the last N days for this task')
  .option('--backup-set <backupSetId>', 'optional — a pure visual/reporting label grouping this task with others')
  .action((opts) => {
    const ctx = buildContext();
    const dbEngine = opts.dbEngine as DbEngine;
    const retentionCount = opts.retentionCount != null ? Number(opts.retentionCount) : null;
    const retentionDays = opts.retentionDays != null ? Number(opts.retentionDays) : null;
    const backupSetId = opts.backupSet ?? null;

    if (opts.strategy === 'direct_dump') {
      if (!opts.databaseConnection) {
        console.error('direct_dump tasks require --database-connection <id>.');
        process.exitCode = 1;
        return;
      }
      const task = ctx.tasksRepo.createDirectDump({
        clientId: opts.client,
        databaseConnectionId: opts.databaseConnection,
        name: opts.name,
        dbEngine,
        retentionCount,
        retentionDays,
        backupSetId,
      });
      console.log(JSON.stringify(task, null, 2));
      return;
    }

    if (!opts.transport) {
      console.error(`${opts.strategy} tasks require --transport <id>.`);
      process.exitCode = 1;
      return;
    }
    const base = { clientId: opts.client, transportId: opts.transport, name: opts.name, dbEngine, retentionCount, retentionDays, backupSetId };
    let task;
    if (opts.strategy === 'remote_dump') {
      if (!opts.remoteOutputPathTemplate) {
        console.error('remote_dump tasks require --remote-output-path-template <template>.');
        process.exitCode = 1;
        return;
      }
      const dockerMode = opts.remoteDumpMode === 'docker';
      if (!dockerMode && !opts.remoteCommand) {
        console.error('remote_dump tasks with --remote-dump-mode host require --remote-command <command>.');
        process.exitCode = 1;
        return;
      }
      if (dockerMode && (!opts.dockerContainer || !opts.remoteDumpDatabase || !opts.remoteDumpDbUser)) {
        console.error('remote_dump tasks with --remote-dump-mode docker require --docker-container, --remote-dump-database, and --remote-dump-db-user.');
        process.exitCode = 1;
        return;
      }
      task = ctx.tasksRepo.createRemoteDump({
        ...base,
        remoteCommand: dockerMode ? undefined : opts.remoteCommand,
        remoteOutputPathTemplate: opts.remoteOutputPathTemplate,
        remoteCleanup: Boolean(opts.remoteCleanup),
        remoteDumpExecMode: dockerMode ? 'docker' : 'host',
        dockerContainer: dockerMode ? opts.dockerContainer : undefined,
        remoteDumpDatabase: dockerMode ? opts.remoteDumpDatabase : undefined,
        remoteDumpDbUser: dockerMode ? opts.remoteDumpDbUser : undefined,
        remoteDumpDbPasswordSecretRef: dockerMode ? resolveSecretRef(ctx, opts.remoteDumpDbPassword, 'task:remoteDumpDbPassword') : undefined,
      });
    } else {
      if (!opts.remotePath) {
        console.error('fetch_existing tasks require --remote-path <path>.');
        process.exitCode = 1;
        return;
      }
      task = ctx.tasksRepo.createFetchExisting({ ...base, remotePath: opts.remotePath, remoteFilePattern: opts.remoteFilePattern ?? null });
    }
    console.log(JSON.stringify(task, null, 2));
  });

program
  .command('task:set-schedule')
  .description(
    "Set, change, or disable a task's schedule (daily by default, or --frequency weekly/monthly). Registering it with Windows Task Scheduler is a separate step (scheduler:install)."
  )
  .argument('<taskId>')
  .option('--time <HH:MM>', '24h local time; required unless only --disable is given')
  .option('--disable', 'disable scheduling without clearing the configured time', false)
  .option('--frequency <daily|weekly|monthly>', 'defaults to the task\'s current frequency, or "daily" for a brand-new schedule')
  .option('--days-of-week <list>', 'comma-separated 0 (Sunday) through 6 (Saturday), e.g. "1,3,5" — required when --frequency weekly')
  .option('--day-of-month <n>', '1-31 — required when --frequency monthly')
  .option('--force', 'for direct_dump tasks, enable the schedule even if the compatibility gate fails', false)
  .action(async (taskId: string, opts) => {
    const ctx = buildContext();
    const task = ctx.tasksRepo.getById(taskId);
    if (!task) {
      console.error(`Task ${taskId} not found.`);
      process.exitCode = 1;
      return;
    }
    if (!opts.time && !opts.disable) {
      console.error('Specify --time <HH:MM> and/or --disable.');
      process.exitCode = 1;
      return;
    }
    if (!opts.disable) {
      const gateFailure = await checkScheduleCompatibilityGate(ctx, task, Boolean(opts.force));
      if (gateFailure) {
        console.error(`Compatibility gate failed: ${gateFailure.message}`);
        console.error(JSON.stringify(gateFailure, null, 2));
        console.error('Re-run with --force to enable the schedule anyway.');
        process.exitCode = 1;
        return;
      }
    }
    const updated = ctx.tasksRepo.setSchedule(taskId, {
      scheduleTime: opts.time ?? task.scheduleTime,
      scheduleEnabled: opts.disable ? false : true,
      scheduleFrequency: opts.frequency,
      scheduleDaysOfWeek: opts.daysOfWeek ? opts.daysOfWeek.split(',').map(Number) : undefined,
      scheduleDayOfMonth: opts.dayOfMonth ? Number(opts.dayOfMonth) : undefined,
    });
    console.log(JSON.stringify(updated, null, 2));
  });

program
  .command('task:update')
  .description(
    "Update a task's name/retention/backup-set. The remote command, output-path template, remote path and file pattern can also be changed, but only while the task has no real backup yet (no Success/Warning run with a file). Strategy/transport/database-connection/db-engine are never editable — create a new task. Only the flags you pass are changed."
  )
  .argument('<taskId>')
  .option('--name <name>')
  .option('--retention-count <n>')
  .option('--retention-days <n>')
  .option('--backup-set <backupSetId>', 'assign/reassign this task to a backup set')
  .option('--clear-backup-set', 'unassign this task from its backup set', false)
  .option('--remote-path <path>', 'fetch_existing: directory on the remote host to look in')
  .option('--remote-file-pattern <glob>', 'fetch_existing: filename glob (pass "" to clear)')
  .option('--remote-command <cmd>', 'remote_dump (host exec mode): the dump command to run on the remote host')
  .option('--remote-output-path-template <tpl>', 'remote_dump: where the dump lands on the remote host (supports {date:...})')
  .option('--remote-cleanup', 'remote_dump: delete the remote dump file after a successful download')
  .option('--remote-keep', 'remote_dump: keep the remote dump file after download (opposite of --remote-cleanup)')
  .action((taskId: string, opts) => {
    const ctx = buildContext();
    const remoteCleanup = opts.remoteCleanup ? true : opts.remoteKeep ? false : undefined;
    const task = ctx.tasksRepo.update(taskId, {
      name: opts.name,
      retentionCount: opts.retentionCount != null ? Number(opts.retentionCount) : undefined,
      retentionDays: opts.retentionDays != null ? Number(opts.retentionDays) : undefined,
      backupSetId: opts.clearBackupSet ? null : opts.backupSet,
      remotePath: opts.remotePath,
      remoteFilePattern: opts.remoteFilePattern,
      remoteCommand: opts.remoteCommand,
      remoteOutputPathTemplate: opts.remoteOutputPathTemplate,
      remoteCleanup,
    });
    console.log(JSON.stringify(task, null, 2));
  });

program
  .command('task:deactivate')
  .description('Deactivate a task. It stops appearing on the dashboard and in scheduling; its run history is untouched.')
  .argument('<taskId>')
  .action((taskId: string) => {
    const ctx = buildContext();
    ctx.tasksRepo.deactivate(taskId);
    console.log(`Deactivated task ${taskId}.`);
  });

program
  .command('task:reactivate')
  .description('Reactivate a previously deactivated task.')
  .argument('<taskId>')
  .action((taskId: string) => {
    const ctx = buildContext();
    ctx.tasksRepo.reactivate(taskId);
    console.log(`Reactivated task ${taskId}.`);
  });

/**
 * trustHost: true bypasses confirmHostInteractively entirely and trusts
 * whatever host key is presented — used only for the UI's explicit "trust
 * this host" retry (see POST /transports/:id/test), *after* the person has
 * already seen the fingerprint from a first test's ConnectionTestResult.unknownHost
 * and chosen to accept it. confirmHostInteractively's own non-TTY rejection
 * (see confirmHost.ts) is what a plain `serve` request would otherwise hit
 * with no way to ever get past it — this is the actual fix for that gap.
 */
function testTransportConnection(
  ctx: ReturnType<typeof buildContext>,
  transport: Transport,
  trustHost?: boolean
): Promise<ConnectionTestResult> {
  const onUnknownHost = trustHost ? async () => true : confirmHostInteractively;
  const adapter =
    transport.type === 'ssh'
      ? createSshAdapterFromTransport(transport, ctx.secretStore, ctx.knownHostsRepo, onUnknownHost)
      : transport.type === 'ftp'
        ? createFtpAdapterFromTransport(transport, ctx.secretStore)
        : createSftpAdapterFromTransport(transport, ctx.secretStore, ctx.knownHostsRepo, onUnknownHost);
  return adapter.testConnection();
}

program
  .command('transport:test')
  .description('Test an SFTP/SSH transport connection directly, without running a backup.')
  .argument('<transportId>')
  .action(async (transportId: string) => {
    const ctx = buildContext();
    const transport = ctx.transportsRepo.getById(transportId);
    if (!transport) {
      console.error(`Transport ${transportId} not found.`);
      process.exitCode = 1;
      return;
    }
    const result = await testTransportConnection(ctx, transport);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  });

program
  .command('database-connection:test')
  .description('Test a direct_dump database connection (connectivity + auth only — no dump is produced).')
  .argument('<databaseConnectionId>')
  .action(async (databaseConnectionId: string) => {
    const ctx = buildContext();
    const connection = ctx.databaseConnectionsRepo.getById(databaseConnectionId);
    if (!connection) {
      console.error(`Database connection ${databaseConnectionId} not found.`);
      process.exitCode = 1;
      return;
    }
    const result = await testDatabaseConnection(connection, ctx.secretStore);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  });

program
  .command('client:test-connections')
  .description("Test every transport and database connection belonging to a client, without running any backup.")
  .argument('<clientId>')
  .action(async (clientId: string) => {
    const ctx = buildContext();
    const client = ctx.clientsRepo.getById(clientId);
    if (!client) {
      console.error(`Client ${clientId} not found.`);
      process.exitCode = 1;
      return;
    }

    const results: Array<{ kind: 'transport' | 'databaseConnection'; id: string; name: string } & ConnectionTestResult> = [];

    for (const transport of ctx.transportsRepo.listByClient(clientId)) {
      const result = await testTransportConnection(ctx, transport);
      results.push({ kind: 'transport', id: transport.id, name: transport.name, ...result });
    }
    for (const connection of ctx.databaseConnectionsRepo.listByClient(clientId)) {
      const result = await testDatabaseConnection(connection, ctx.secretStore);
      results.push({ kind: 'databaseConnection', id: connection.id, name: connection.name, ...result });
    }

    console.log(JSON.stringify(results, null, 2));
    if (results.some((r) => !r.ok)) process.exitCode = 1;
  });

program
  .command('task:run')
  .description('Run a backup task now.')
  .argument('<taskId>')
  .action(async (taskId: string) => {
    const ctx = buildContext();
    const task = ctx.tasksRepo.getById(taskId);
    if (!task) {
      console.error(`Task ${taskId} not found.`);
      process.exitCode = 1;
      return;
    }

    const result = await runTaskNow(ctx, task);

    console.log(JSON.stringify(result.run, null, 2));
    if (result.run.status === 'Failed') process.exitCode = 1;
  });

/** Shared by the `task:test-connection` CLI command and the `serve` HTTP endpoint. Throws if the task or its transport/database connection can't be resolved. trustHost mirrors testTransportConnection's — irrelevant for direct_dump (no host-key concept for a DB connection). */
async function testTaskConnection(
  ctx: ReturnType<typeof buildContext>,
  task: NonNullable<ReturnType<typeof ctx.tasksRepo.getById>>,
  trustHost?: boolean
): Promise<ConnectionTestResult> {
  if (task.strategy === 'direct_dump') {
    const connection = task.databaseConnectionId ? ctx.databaseConnectionsRepo.getById(task.databaseConnectionId) : null;
    if (!connection) throw new Error(`Task ${task.id} has no valid database connection configured.`);
    return testDatabaseConnection(connection, ctx.secretStore);
  }
  const transport = task.transportId ? ctx.transportsRepo.getById(task.transportId) : null;
  if (!transport) throw new Error(`Task ${task.id} has no valid transport configured.`);
  return testTransportConnection(ctx, transport, trustHost);
}

/**
 * The pre-flight compatibility gate (connection + detected server version +
 * a usable local dump tool) — only meaningful for direct_dump tasks. Shared
 * by the `task:test-compatibility` CLI command and the `serve` HTTP endpoint.
 */
async function testTaskCompatibility(
  ctx: ReturnType<typeof buildContext>,
  task: NonNullable<ReturnType<typeof ctx.tasksRepo.getById>>
): Promise<DirectDumpCompatibilityResult> {
  if (task.strategy !== 'direct_dump') {
    throw new Error(`Task ${task.id} is a ${task.strategy} task — the compatibility gate only applies to direct_dump.`);
  }
  const connection = task.databaseConnectionId ? ctx.databaseConnectionsRepo.getById(task.databaseConnectionId) : null;
  if (!connection) throw new Error(`Task ${task.id} has no valid database connection configured.`);
  return testDirectDumpCompatibility(connection, ctx.secretStore, ctx.settingsRepo);
}

/**
 * Runs the compatibility gate only when actually needed: skipped for
 * non-direct_dump tasks (no equivalent concept applies) and whenever
 * `force` is set (an explicit override). Returns the failing result, or
 * `null` when there's nothing blocking the schedule from being enabled.
 */
async function checkScheduleCompatibilityGate(
  ctx: ReturnType<typeof buildContext>,
  task: BackupTask,
  force: boolean
): Promise<DirectDumpCompatibilityResult | null> {
  if (force || task.strategy !== 'direct_dump') return null;
  const connection = task.databaseConnectionId ? ctx.databaseConnectionsRepo.getById(task.databaseConnectionId) : null;
  if (!connection) return null;
  const result = await testDirectDumpCompatibility(connection, ctx.secretStore, ctx.settingsRepo);
  return result.ok ? null : result;
}

/** Shared by the `task:run` CLI command and the `serve` HTTP endpoint. */
function runTaskNow(ctx: ReturnType<typeof buildContext>, task: NonNullable<ReturnType<typeof ctx.tasksRepo.getById>>) {
  return runBackupTask(task, {
    clientsRepo: ctx.clientsRepo,
    transportsRepo: ctx.transportsRepo,
    databaseConnectionsRepo: ctx.databaseConnectionsRepo,
    runsRepo: ctx.runsRepo,
    logEventsRepo: ctx.logEventsRepo,
    knownHostsRepo: ctx.knownHostsRepo,
    retentionDeletionsRepo: ctx.retentionDeletionsRepo,
    secretStore: ctx.secretStore,
    settingsRepo: ctx.settingsRepo,
    onUnknownHost: confirmHostInteractively,
    onProgress: ctx.dbProgressSink,
  });
}

program
  .command('task:test-connection')
  .description("Test a task's transport or database connection, without running a backup.")
  .argument('<taskId>')
  .action(async (taskId: string) => {
    const ctx = buildContext();
    const task = ctx.tasksRepo.getById(taskId);
    if (!task) {
      console.error(`Task ${taskId} not found.`);
      process.exitCode = 1;
      return;
    }

    const result = await testTaskConnection(ctx, task);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  });

program
  .command('task:test-compatibility')
  .description(
    "Pre-flight compatibility gate for a direct_dump task: connection + detected server version + a usable local dump tool. Distinct from task:test-connection, which only proves auth."
  )
  .argument('<taskId>')
  .action(async (taskId: string) => {
    const ctx = buildContext();
    const task = ctx.tasksRepo.getById(taskId);
    if (!task) {
      console.error(`Task ${taskId} not found.`);
      process.exitCode = 1;
      return;
    }
    try {
      const result = await testTaskCompatibility(ctx, task);
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) process.exitCode = 1;
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

program
  .command('run-due')
  .description('Run every currently-due scheduled task (or just one, with --task). This is what a Windows Scheduled Task actually invokes.')
  .option('--task <taskId>', 'check/run just this one task instead of every scheduled task')
  .action(async (opts) => {
    const ctx = buildContext();

    let tasks;
    if (opts.task) {
      const task = ctx.tasksRepo.getById(opts.task);
      if (!task) {
        console.error(`Task ${opts.task} not found.`);
        process.exitCode = 1;
        return;
      }
      tasks = [task];
    } else {
      tasks = ctx.tasksRepo.listScheduled();
    }

    const deps: RunBackupTaskDeps = {
      clientsRepo: ctx.clientsRepo,
      transportsRepo: ctx.transportsRepo,
      databaseConnectionsRepo: ctx.databaseConnectionsRepo,
      runsRepo: ctx.runsRepo,
      logEventsRepo: ctx.logEventsRepo,
      knownHostsRepo: ctx.knownHostsRepo,
      retentionDeletionsRepo: ctx.retentionDeletionsRepo,
      settingsRepo: ctx.settingsRepo,
      secretStore: ctx.secretStore,
      // runDueTasks itself stamps every run it starts as 'scheduled' (see
      // its own note) — nothing to set here for that.
      //
      // An unattended run has no interactive terminal, so this correctly
      // (and intentionally) rejects any host that isn't already known —
      // never silently trusting a new host just because nobody's watching.
      onUnknownHost: confirmHostInteractively,
      onProgress: ctx.dbProgressSink,
    };

    const results = await runDueTasks(tasks, deps, new Date());
    console.log(JSON.stringify(results, null, 2));
    if (results.some((r) => r.error || r.result?.run.status === 'Failed')) process.exitCode = 1;
  });

program
  .command('scheduler:tick')
  .description(
    'One scheduler cycle: run every currently-due DB-backup task, every due file-backup task, any due repository maintenance, then stamp the heartbeat. This is what the arkode-scheduler Windows service invokes every 60s. Always exits 0 unless the process itself crashes — a Failed backup is not a tick failure.'
  )
  .action(async () => {
    const ctx = buildContext();
    const result = await runSchedulerTick(
      {
        tasksRepo: ctx.tasksRepo,
        fileBackupTasksRepo: ctx.fileBackupTasksRepo,
        settingsRepo: ctx.settingsRepo,
        dbTaskDeps: {
          clientsRepo: ctx.clientsRepo,
          transportsRepo: ctx.transportsRepo,
          databaseConnectionsRepo: ctx.databaseConnectionsRepo,
          runsRepo: ctx.runsRepo,
          logEventsRepo: ctx.logEventsRepo,
          knownHostsRepo: ctx.knownHostsRepo,
          retentionDeletionsRepo: ctx.retentionDeletionsRepo,
          settingsRepo: ctx.settingsRepo,
          secretStore: ctx.secretStore,
          onUnknownHost: confirmHostInteractively,
          onProgress: ctx.dbProgressSink,
        },
        fileTaskDeps: { ...buildFileBackupTaskDeps(ctx), fileBackupRunsRepo: ctx.fileBackupRunsRepo },
        maintenanceDeps: {
          fileBackupRepositoriesRepo: ctx.fileBackupRepositoriesRepo,
          fileBackupMaintenanceRunsRepo: ctx.fileBackupMaintenanceRunsRepo,
          fileBackupRunsRepo: ctx.fileBackupRunsRepo,
          secretStore: ctx.secretStore,
        },
        replicationTargetsRepo: ctx.replicationTargetsRepo,
        replicationDeps: buildReplicationDeps(ctx),
      },
      new Date()
    );
    console.log(JSON.stringify(result));
  });

program
  .command('scheduler:cleanup-legacy')
  .description(
    'Remove the pre-service per-task Windows Scheduled Tasks (\\arkode\\*) and the global maintenance task, and clear windows_task_name on every task row. Run once by the installer when migrating to the arkode-scheduler service. Idempotent; tolerant of "not found".'
  )
  .action(async () => {
    const ctx = buildContext();
    const removed: string[] = [];
    const names = await listArkodeScheduledTaskNames();
    for (const name of new Set([...names, '\\arkode\\file-backup-maintenance'])) {
      try {
        await uninstallScheduledTask(name);
        removed.push(name);
      } catch {
        /* not found / already gone */
      }
    }
    const db = ctx.db.prepare(`UPDATE backup_tasks SET windows_task_name = NULL WHERE windows_task_name IS NOT NULL`).run();
    const file = ctx.db
      .prepare(`UPDATE file_backup_tasks SET windows_task_name = NULL WHERE windows_task_name IS NOT NULL`)
      .run();
    console.log(JSON.stringify({ removedScheduledTasks: removed, clearedDbRows: db.changes, clearedFileRows: file.changes }));
  });

program
  .command('scheduler:service-status')
  .description('Print { installed, running, state } for the arkode-scheduler Windows service, as JSON. No elevation needed.')
  .action(async () => {
    console.log(JSON.stringify(await schedulerServiceStatus()));
  });

program
  .command('scheduler:service-restart')
  .description('Stop then start the arkode-scheduler Windows service. Must be run elevated.')
  .action(async () => {
    await restartSchedulerService();
    console.log(JSON.stringify(await schedulerServiceStatus()));
  });

program
  .command('scheduler:service-reinstall')
  .description('Delete and recreate the arkode-scheduler Windows service from this install. Must be run elevated.')
  .action(async () => {
    const installDir = joinPath(process.execPath, '..');
    await reinstallSchedulerService(installDir);
    const ctx = buildContext();
    try {
      // Also clear any legacy per-task Scheduled Tasks on a reinstall, same as the installer does.
      for (const name of new Set([...(await listArkodeScheduledTaskNames()), '\\arkode\\file-backup-maintenance'])) {
        await uninstallScheduledTask(name).catch(() => {});
      }
      ctx.db.prepare(`UPDATE backup_tasks SET windows_task_name = NULL WHERE windows_task_name IS NOT NULL`).run();
      ctx.db.prepare(`UPDATE file_backup_tasks SET windows_task_name = NULL WHERE windows_task_name IS NOT NULL`).run();
    } catch {
      /* best-effort cleanup */
    }
    console.log(JSON.stringify(await schedulerServiceStatus()));
  });

program
  .command('scheduler:install')
  .description(
    "Register a Windows Scheduled Task for a task, using its already-configured schedule (set one first via task:set-schedule). Runs as SYSTEM — no Windows password needed — but registering it requires this process itself to be running elevated (as Administrator)."
  )
  .argument('<taskId>')
  .action(async (taskId: string) => {
    const ctx = buildContext();
    const task = ctx.tasksRepo.getById(taskId);
    if (!task) {
      console.error(`Task ${taskId} not found.`);
      process.exitCode = 1;
      return;
    }
    if (!task.scheduleEnabled || !task.scheduleTime) {
      console.error(`Task ${taskId} has no enabled schedule — set one first: task:set-schedule ${taskId} --time HH:MM`);
      process.exitCode = 1;
      return;
    }

    // A human-readable name, computed fresh from the task's *current* name
    // right here at registration time, then stored (setWindowsTaskName
    // below) so uninstall/status never need to recompute it later — see
    // scheduledTaskDisplayName's own doc comment for why a later rename
    // must never change what string those look for.
    const taskName = scheduledTaskDisplayName(taskId, task.name);
    // `process.pkg` is set (to a truthy object) only when this code is
    // actually running as the @yao-pkg/pkg-compiled engine-cli.exe — see
    // CLAUDE.md's "Packaging" section. In that case process.execPath IS the
    // real, callable exe path, and process.argv[1] is a fake in-snapshot
    // path ("C:\snapshot\...") that isn't a real file on disk, so it must
    // never be passed as an argument. Under plain `node dist/index.js`
    // (today's only real usage, until packaging ships), process.execPath is
    // node.exe and the script path genuinely needs to be passed explicitly.
    const isPkgExe = Boolean((process as NodeJS.Process & { pkg?: unknown }).pkg);
    const scriptPath = process.argv[1];

    await installScheduledTask({
      taskName,
      description: `arkode - scheduled run for task "${task.name}"`,
      scheduleTime: task.scheduleTime,
      command: process.execPath,
      arguments: isPkgExe ? `run-due --task ${taskId}` : `"${scriptPath}" run-due --task ${taskId}`,
    });
    ctx.tasksRepo.setWindowsTaskName(taskId, taskName);

    console.log(`Registered Windows Scheduled Task "${taskName}" for task "${task.name}" at ${task.scheduleTime} daily, running as SYSTEM.`);
  });

program
  .command('scheduler:uninstall')
  .description("Remove a task's Windows Scheduled Task.")
  .argument('<taskId>')
  .action(async (taskId: string) => {
    const ctx = buildContext();
    const task = ctx.tasksRepo.getById(taskId);
    if (!task) {
      console.error(`Task ${taskId} not found.`);
      process.exitCode = 1;
      return;
    }
    // Falls back to the old id-only scheme for a task registered before
    // scheduledTaskDisplayName existed — its stored windowsTaskName is null
    // (never set), but the OS-side registration still used the old naming.
    const taskName = task.windowsTaskName ?? scheduledTaskNameForBackupTask(taskId);
    await uninstallScheduledTask(taskName);
    ctx.tasksRepo.setWindowsTaskName(taskId, null);
    console.log(`Removed Windows Scheduled Task "${taskName}".`);
  });

program
  .command('scheduler:status')
  .description("Check whether a task's Windows Scheduled Task is registered.")
  .argument('<taskId>')
  .action(async (taskId: string) => {
    const ctx = buildContext();
    const task = ctx.tasksRepo.getById(taskId);
    if (!task) {
      console.error(`Task ${taskId} not found.`);
      process.exitCode = 1;
      return;
    }
    const taskName = task.windowsTaskName ?? scheduledTaskNameForBackupTask(taskId);
    const status = await scheduledTaskStatus(taskName);
    console.log(JSON.stringify(status, null, 2));
    if (status.ranNonElevated) {
      console.error(
        '\nNota: esta consulta no corrió como administrador. Una tarea registrada (que siempre corre como SYSTEM) solo se puede confirmar desde una sesión elevada — "exists: false" acá puede significar "no se pudo verificar", no "no está registrada". Volvé a intentarlo desde una terminal "Ejecutar como administrador".'
      );
    }
    if (!status.exists) process.exitCode = 1;
  });

program
  .command('retention:history')
  .description('List backups retention has deleted for a task.')
  .argument('<taskId>')
  .action((taskId: string) => {
    const ctx = buildContext();
    const deletions = ctx.retentionDeletionsRepo.listByTask(taskId);
    console.log(JSON.stringify(deletions, null, 2));
  });

program
  .command('run:list')
  .description('List past backup runs (any status), newest first — optionally filtered by task or client.')
  .option('--task <taskId>')
  .option('--client <clientId>')
  .option('--limit <n>', 'default 200', '200')
  .action((opts) => {
    const ctx = buildContext();
    const runs = ctx.runsRepo.listRecent({ taskId: opts.task, clientId: opts.client, limit: Number(opts.limit) });
    console.log(JSON.stringify(runs, null, 2));
  });

program
  .command('backup:list')
  .description('List real backups (Success/Warning runs with a file on disk) — as opposed to run:list\'s every-attempt view. Paginated, newest first.')
  .option('--client <clientId>')
  .option('--task <taskId>')
  .option('--limit <n>', 'default 50', '50')
  .option('--offset <n>', 'default 0', '0')
  .action((opts) => {
    const ctx = buildContext();
    const result = ctx.runsRepo.listBackups({
      clientId: opts.client,
      taskId: opts.task,
      limit: Number(opts.limit),
      offset: Number(opts.offset),
    });
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command('run:delete')
  .description("Permanently delete one backup's file on disk (manual, not automated retention) — the run row/history stays for audit.")
  .argument('<runId>')
  .action(async (runId: string) => {
    const ctx = buildContext();
    try {
      const result = await deleteBackupRun(runId, { runsRepo: ctx.runsRepo, retentionDeletionsRepo: ctx.retentionDeletionsRepo });
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

program
  .command('log:list')
  .description('List log_events (any run), newest first, paginated and filterable — the same data backing the UI\'s Logs screen.')
  .option('--search <text>', 'substring match against the message')
  .option('--step <step>', 'e.g. connect | produce | download | validate | result | retention | recovery')
  .option('--level <level>', 'debug | info | warn | error')
  .option('--from <isoDate>', 'inclusive lower bound on created_at')
  .option('--to <isoDate>', 'inclusive upper bound on created_at')
  .option('--limit <n>', 'default 50', '50')
  .option('--offset <n>', 'default 0', '0')
  .action((opts) => {
    const ctx = buildContext();
    const result = ctx.logEventsRepo.listRecent({
      search: opts.search,
      step: opts.step,
      level: opts.level,
      from: opts.from,
      to: opts.to,
      limit: Number(opts.limit),
      offset: Number(opts.offset),
    });
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command('config:export')
  .description('Export one, several, or all clients\' configuration to JSON. Never includes secrets (SSH passphrases, DB passwords) — see config:import.')
  .option('--client <clientId>', 'repeatable: export just this client', (value, previous: string[]) => [...previous, value], [] as string[])
  .option('--all', 'export every active client')
  .option('--output <path>', 'write to this file instead of stdout')
  .action(async (opts) => {
    const ctx = buildContext();
    if (!opts.all && opts.client.length === 0) {
      console.error('Specify --client <id> (repeatable) or --all.');
      process.exitCode = 1;
      return;
    }
    const data = exportConfig(opts.all ? 'all' : opts.client, ctx);
    const json = JSON.stringify(data, null, 2);
    if (opts.output) {
      await writeFile(opts.output, json, 'utf8');
      console.log(`Wrote ${data.clients.length} client(s) to ${opts.output}`);
    } else {
      console.log(json);
    }
  });

program
  .command('config:import')
  .description('Import client configuration from a config:export JSON file. Always creates new clients — never overwrites an existing one with the same name.')
  .requiredOption('--file <path>')
  .action(async (opts) => {
    const ctx = buildContext();
    const raw = await readFile(opts.file, 'utf8');
    const data = JSON.parse(raw) as ConfigExport;
    if (data.schemaVersion !== 1) {
      console.error(`Unsupported config export schemaVersion: ${data.schemaVersion}`);
      process.exitCode = 1;
      return;
    }

    const result = importConfig(data, ctx);
    console.log(JSON.stringify(result, null, 2));

    const anySecrets = result.clients.some((c) => c.secretsNeedingReentry.length > 0);
    if (anySecrets) {
      console.error(
        '\nSecrets (SSH key passphrases, DB passwords) are never exported and must be re-entered for the items listed above under "secretsNeedingReentry".'
      );
    }
    if (result.clients.some((c) => c.errors.length > 0)) process.exitCode = 1;
  });

program
  .command('task:export')
  .description(
    'Export one task plus the one transport or database connection it depends on — a portable unit, unlike config:export which always carries a whole client. Never includes secrets. See task:import.'
  )
  .argument('<taskId>')
  .option('--output <path>', 'write to this file instead of stdout')
  .action(async (taskId: string, opts) => {
    const ctx = buildContext();
    const bundle = exportTask(taskId, ctx);
    const json = JSON.stringify(bundle, null, 2);
    if (opts.output) {
      await writeFile(opts.output, json, 'utf8');
      console.log(`Wrote task "${bundle.task.name}" to ${opts.output}`);
    } else {
      console.log(json);
    }
  });

program
  .command('task:import')
  .description('Import a task:export JSON file, attaching it to an existing client (unlike config:import, which always creates a new one).')
  .requiredOption('--file <path>')
  .requiredOption('--client <clientId>', 'existing client to attach the imported task to')
  .action(async (opts) => {
    const ctx = buildContext();
    const raw = await readFile(opts.file, 'utf8');
    const data = JSON.parse(raw) as ExportedTaskBundle;
    if (data.schemaVersion !== 1) {
      console.error(`Unsupported task export schemaVersion: ${data.schemaVersion}`);
      process.exitCode = 1;
      return;
    }

    const result = importTaskBundle(data, opts.client, ctx);
    console.log(JSON.stringify(result, null, 2));

    if (result.secretsNeedingReentry.length > 0) {
      console.error(
        '\nSecrets (SSH key passphrases, FTP/DB passwords) are never exported and must be re-entered for the items listed above under "secretsNeedingReentry".'
      );
    }
    if (result.errors.length > 0) process.exitCode = 1;
  });

program
  .command('status')
  .description('Show the latest run per active client/task.')
  .option('--json', 'output as JSON')
  .action((opts) => {
    const ctx = buildContext();
    const rows = getDashboardStatus(ctx);

    if (opts.json) {
      console.log(JSON.stringify(rows, null, 2));
    } else {
      console.table(rows);
    }
  });

program
  .command('system:info')
  .description("Show where the app's data lives and whether each direct_dump tool-path env var is configured and points at a real file.")
  .action(() => {
    console.log(JSON.stringify(getSystemInfo(), null, 2));
  });

program
  .command('vault:status')
  .description('Show whether the encrypted credential vault is initialized and (in this process) unlocked.')
  .action(() => {
    const ctx = buildContext();
    console.log(JSON.stringify(getVaultStatus(ctx.vaultState), null, 2));
  });

program
  .command('vault:init')
  .description('Set the master password for the encrypted credential vault (one-time). Prompts on the terminal; the password is never taken from argv.')
  .action(async () => {
    const ctx = buildContext();
    if (ctx.vaultState.isInitialized()) {
      console.error('The vault is already initialized. Use "vault:change-password" to change the master password.');
      process.exitCode = 1;
      return;
    }
    const password = await promptPassword('New master password: ');
    if (password.length < 8) {
      console.error('Master password must be at least 8 characters.');
      process.exitCode = 1;
      return;
    }
    const again = await promptPassword('Confirm master password: ');
    if (again !== password) {
      console.error('Passwords did not match.');
      process.exitCode = 1;
      return;
    }
    ctx.vaultState.init(password);
    console.log('Vault initialized. Keep this password safe — there is no recovery if it is lost.');
  });

program
  .command('vault:change-password')
  .description('Change the vault master password. Prompts on the terminal.')
  .action(async () => {
    const ctx = buildContext();
    if (!ctx.vaultState.isInitialized()) {
      console.error('The vault is not initialized. Run "vault:init" first.');
      process.exitCode = 1;
      return;
    }
    const current = await promptPassword('Current master password: ');
    const next = await promptPassword('New master password: ');
    if (next.length < 8) {
      console.error('Master password must be at least 8 characters.');
      process.exitCode = 1;
      return;
    }
    if ((await promptPassword('Confirm new master password: ')) !== next) {
      console.error('Passwords did not match.');
      process.exitCode = 1;
      return;
    }
    try {
      ctx.vaultState.changePassword(current, next);
      console.log('Master password changed.');
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

/** Prompts for the master password and unlocks the vault for this (short-lived) CLI process. */
async function unlockVaultForCli(ctx: ReturnType<typeof buildContext>): Promise<boolean> {
  if (!ctx.vaultState.isInitialized()) {
    console.error('The vault is not initialized. Run "vault:init" first.');
    return false;
  }
  if (ctx.vaultState.isUnlocked()) return true;
  try {
    ctx.vaultState.unlock(await promptPassword('Master password: '));
    return true;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return false;
  }
}

program
  .command('vault:credential:list')
  .description('List vault credentials (metadata only — no secrets, no unlock needed).')
  .option('--client <clientId>', 'filter to one client')
  .action((opts) => {
    const ctx = buildContext();
    const rows = opts.client
      ? ctx.vaultCredentialsRepo.listByClient(opts.client)
      : ctx.vaultCredentialsRepo.listAll();
    console.log(JSON.stringify(rows, null, 2));
  });

program
  .command('vault:credential:show')
  .description('Show one credential including its decrypted secret. Prompts for the master password.')
  .argument('<credentialId>')
  .action(async (credentialId: string) => {
    const ctx = buildContext();
    const cred = ctx.vaultCredentialsRepo.getById(credentialId);
    if (!cred) {
      console.error(`Vault credential ${credentialId} not found.`);
      process.exitCode = 1;
      return;
    }
    if (!(await unlockVaultForCli(ctx))) {
      process.exitCode = 1;
      return;
    }
    const secret = cred.secretBlobRef ? readCredentialSecret(ctx.vaultSecretStore, cred.secretBlobRef) : {};
    console.log(JSON.stringify({ ...cred, secret }, null, 2));
  });

async function promptCredentialSecretInteractively(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const password = await promptPassword('  password (blank to skip): ');
  if (password) out.password = password;
  const token = await promptPassword('  token/secret (blank to skip): ');
  if (token) out.token = token;
  const notes = await promptPassword('  notes (blank to skip): ');
  if (notes) out.notes = notes;
  return out;
}

program
  .command('vault:credential:add')
  .description('Create a vault credential. Prompts for the secret values (never taken from argv).')
  .requiredOption('--client <clientId>')
  .requiredOption('--name <name>')
  .requiredOption('--kind <kind>', 'ssh|sftp|ftp|postgres|mysql|mariadb|smtp|http_basic|web_panel|api|oauth_client|generic_login|generic_secret|ssh_key|custom')
  .option('--host <host>')
  .option('--port <port>')
  .option('--username <username>')
  .option('--database <databaseName>')
  .option('--url <url>')
  .option('--environment <environment>')
  .option('--tags <tags>', 'comma-separated')
  .option('--description <description>')
  .option('--favorite', 'pin this credential', false)
  .action(async (opts) => {
    const ctx = buildContext();
    if (!(await unlockVaultForCli(ctx))) {
      process.exitCode = 1;
      return;
    }
    console.log('Enter secret values:');
    const secret = normalizeCredentialSecret(await promptCredentialSecretInteractively());
    let secretBlobRef: string | null = null;
    if (secret) {
      secretBlobRef = newCredentialSecretRef();
      writeCredentialSecret(ctx.vaultSecretStore, secretBlobRef, secret);
    }
    try {
      const created = ctx.vaultCredentialsRepo.create({
        clientId: opts.client,
        name: opts.name,
        kind: opts.kind,
        host: opts.host ?? null,
        port: opts.port != null ? Number(opts.port) : null,
        username: opts.username ?? null,
        databaseName: opts.database ?? null,
        url: opts.url ?? null,
        environment: opts.environment ?? null,
        tags: opts.tags ? String(opts.tags).split(',').map((t: string) => t.trim()).filter(Boolean) : [],
        description: opts.description ?? null,
        favorite: Boolean(opts.favorite),
        secretBlobRef,
      });
      console.log(JSON.stringify(created, null, 2));
    } catch (err) {
      if (secretBlobRef) ctx.vaultSecretStore.delete(secretBlobRef);
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

program
  .command('vault:credential:edit')
  .description("Update a credential's metadata, and optionally re-enter its secret with --set-secret.")
  .argument('<credentialId>')
  .option('--name <name>')
  .option('--kind <kind>', 'change the kind (only allowed while not linked to a backup connection)')
  .option('--host <host>')
  .option('--port <port>')
  .option('--username <username>')
  .option('--database <databaseName>')
  .option('--url <url>')
  .option('--environment <environment>')
  .option('--tags <tags>', 'comma-separated (replaces the whole list)')
  .option('--description <description>')
  .option('--favorite <bool>', 'true|false')
  .option('--set-secret', 'prompt for and replace the secret values', false)
  .action(async (credentialId: string, opts) => {
    const ctx = buildContext();
    const existing = ctx.vaultCredentialsRepo.getById(credentialId);
    if (!existing) {
      console.error(`Vault credential ${credentialId} not found.`);
      process.exitCode = 1;
      return;
    }
    const patch: Record<string, unknown> = {};
    if (opts.name !== undefined) patch.name = opts.name;
    if (opts.kind !== undefined) patch.kind = opts.kind;
    if (opts.host !== undefined) patch.host = opts.host;
    if (opts.port !== undefined) patch.port = Number(opts.port);
    if (opts.username !== undefined) patch.username = opts.username;
    if (opts.database !== undefined) patch.databaseName = opts.database;
    if (opts.url !== undefined) patch.url = opts.url;
    if (opts.environment !== undefined) patch.environment = opts.environment;
    if (opts.tags !== undefined) patch.tags = String(opts.tags).split(',').map((t: string) => t.trim()).filter(Boolean);
    if (opts.description !== undefined) patch.description = opts.description;
    if (opts.favorite !== undefined) patch.favorite = String(opts.favorite) === 'true';

    if (Object.keys(patch).length > 0) ctx.vaultCredentialsRepo.update(credentialId, patch);

    if (opts.setSecret) {
      if (!(await unlockVaultForCli(ctx))) {
        process.exitCode = 1;
        return;
      }
      console.log('Enter new secret values:');
      const secret = normalizeCredentialSecret(await promptCredentialSecretInteractively());
      const ref = existing.secretBlobRef ?? newCredentialSecretRef();
      if (secret) {
        writeCredentialSecret(ctx.vaultSecretStore, ref, secret);
        if (!existing.secretBlobRef) ctx.vaultCredentialsRepo.setSecretBlobRef(credentialId, ref);
      } else if (existing.secretBlobRef) {
        ctx.vaultSecretStore.delete(existing.secretBlobRef);
        ctx.vaultCredentialsRepo.setSecretBlobRef(credentialId, null);
      }
    }
    console.log(JSON.stringify(ctx.vaultCredentialsRepo.getById(credentialId), null, 2));
  });

program
  .command('vault:credential:rm')
  .description('Delete a vault credential and its encrypted secret blob.')
  .argument('<credentialId>')
  .action((credentialId: string) => {
    const ctx = buildContext();
    try {
      const { secretBlobRef } = ctx.vaultCredentialsRepo.delete(credentialId);
      if (secretBlobRef) ctx.vaultSecretStore.delete(secretBlobRef);
      console.log('Deleted.');
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

program
  .command('vault:credential:link')
  .description('Use this credential for backups: create/refresh a machine-bound operational copy (Tier 1) and link it.')
  .argument('<credentialId>')
  .action(async (credentialId: string) => {
    const ctx = buildContext();
    if (!ctx.vaultCredentialsRepo.getById(credentialId)) {
      console.error(`Vault credential ${credentialId} not found.`);
      process.exitCode = 1;
      return;
    }
    if (!(await unlockVaultForCli(ctx))) {
      process.exitCode = 1;
      return;
    }
    const result = syncOperationalCopy(buildVaultSyncDeps(ctx), credentialId, { useForBackups: true });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  });

program
  .command('vault:credential:unlink')
  .description('Stop using this credential for backups. The existing backup job keeps its last-synced secret.')
  .argument('<credentialId>')
  .action((credentialId: string) => {
    const ctx = buildContext();
    try {
      const result = syncOperationalCopy(buildVaultSyncDeps(ctx), credentialId, { useForBackups: false });
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

program
  .command('vault:resync-operational')
  .description('Re-derive every linked credential\'s Tier-1 DPAPI secret + operational key file from the vault (disaster recovery / repair).')
  .option('--client <clientId>', 'limit to one client')
  .action(async (opts) => {
    const ctx = buildContext();
    if (!(await unlockVaultForCli(ctx))) {
      process.exitCode = 1;
      return;
    }
    const results = resyncOperationalCopies(buildVaultSyncDeps(ctx), opts.client ?? undefined);
    console.log(JSON.stringify(results, null, 2));
    if (results.some((r) => !r.result.ok)) process.exitCode = 1;
  });

program
  .command('vault:url:add')
  .description('Add a project URL (plaintext).')
  .requiredOption('--client <clientId>')
  .requiredOption('--name <name>')
  .requiredOption('--url <url>')
  .option('--environment <environment>')
  .option('--tags <tags>', 'comma-separated')
  .option('--credential <credentialId>', 'link to a vault credential')
  .option('--description <description>')
  .option('--favorite', 'pin', false)
  .action((opts) => {
    const ctx = buildContext();
    const created = ctx.vaultUrlsRepo.create({
      clientId: opts.client,
      name: opts.name,
      url: opts.url,
      environment: opts.environment ?? null,
      tags: opts.tags ? String(opts.tags).split(',').map((t: string) => t.trim()).filter(Boolean) : [],
      linkedCredentialId: opts.credential ?? null,
      description: opts.description ?? null,
      favorite: Boolean(opts.favorite),
    });
    console.log(JSON.stringify(created, null, 2));
  });

program
  .command('vault:url:list')
  .description('List project URLs.')
  .option('--client <clientId>')
  .action((opts) => {
    const ctx = buildContext();
    console.log(JSON.stringify(opts.client ? ctx.vaultUrlsRepo.listByClient(opts.client) : ctx.vaultUrlsRepo.listAll(), null, 2));
  });

program
  .command('vault:url:rm')
  .argument('<urlId>')
  .description('Delete a project URL.')
  .action((urlId: string) => {
    const ctx = buildContext();
    try {
      ctx.vaultUrlsRepo.delete(urlId);
      console.log('Deleted.');
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

program
  .command('vault:item:add')
  .description('Add a snippet, process or note.')
  .requiredOption('--client <clientId>')
  .requiredOption('--type <type>', 'snippet|process|note')
  .requiredOption('--title <title>')
  .option('--body <body>', 'plaintext body (for a non-sensitive item)')
  .option('--language <language>', 'snippet language')
  .option('--environment <environment>')
  .option('--tags <tags>', 'comma-separated')
  .option('--description <description>')
  .option('--sensitive', 'store the body encrypted (prompts for it)', false)
  .option('--favorite', 'pin', false)
  .action(async (opts) => {
    const ctx = buildContext();
    let bodyPlaintext: string | null = opts.body ?? null;
    let bodyBlobRef: string | null = null;
    if (opts.sensitive) {
      if (!(await unlockVaultForCli(ctx))) {
        process.exitCode = 1;
        return;
      }
      const body = await promptPassword('Body (hidden): ');
      bodyBlobRef = `vault:item:${randomUUID()}`;
      ctx.vaultSecretStore.set(bodyBlobRef, body);
      bodyPlaintext = null;
    }
    const created = ctx.vaultItemsRepo.create({
      clientId: opts.client,
      type: opts.type,
      title: opts.title,
      environment: opts.environment ?? null,
      tags: opts.tags ? String(opts.tags).split(',').map((t: string) => t.trim()).filter(Boolean) : [],
      description: opts.description ?? null,
      favorite: Boolean(opts.favorite),
      isSensitive: Boolean(opts.sensitive),
      bodyPlaintext,
      bodyBlobRef,
      metadata: opts.language ? { language: opts.language } : {},
    });
    console.log(JSON.stringify(created, null, 2));
  });

program
  .command('vault:item:list')
  .description('List snippets/processes/notes.')
  .option('--client <clientId>')
  .option('--type <type>', 'snippet|process|note')
  .action((opts) => {
    const ctx = buildContext();
    const rows = opts.client
      ? ctx.vaultItemsRepo.listByClient(opts.client, opts.type)
      : ctx.vaultItemsRepo.listAll();
    console.log(JSON.stringify(rows, null, 2));
  });

program
  .command('vault:item:show')
  .description('Show one item including its body (prompts for the master password if sensitive).')
  .argument('<itemId>')
  .action(async (itemId: string) => {
    const ctx = buildContext();
    const item = ctx.vaultItemsRepo.getById(itemId);
    if (!item) {
      console.error(`Vault item ${itemId} not found.`);
      process.exitCode = 1;
      return;
    }
    let body: string | null = item.bodyPlaintext;
    if (item.isSensitive) {
      if (!(await unlockVaultForCli(ctx))) {
        process.exitCode = 1;
        return;
      }
      body = item.bodyBlobRef ? ctx.vaultSecretStore.get(item.bodyBlobRef) : '';
    }
    console.log(JSON.stringify({ ...item, body }, null, 2));
  });

program
  .command('vault:item:rm')
  .argument('<itemId>')
  .description('Delete a snippet/process/note and its encrypted body (if any).')
  .action((itemId: string) => {
    const ctx = buildContext();
    try {
      const { bodyBlobRef } = ctx.vaultItemsRepo.delete(itemId);
      if (bodyBlobRef) ctx.vaultSecretStore.delete(bodyBlobRef);
      console.log('Deleted.');
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

program
  .command('vault:backup-target:add')
  .description('Add a filesystem destination for the portable encrypted vault backup (.arkvault). Only encrypted material is written there.')
  .requiredOption('--path <dir>')
  .option('--retention-count <n>', 'keep only the newest N .arkvault files there')
  .option('--disabled', 'add it disabled', false)
  .action((opts) => {
    const ctx = buildContext();
    const t = ctx.vaultBackupTargetsRepo.create({
      path: opts.path,
      retentionCount: opts.retentionCount != null ? Number(opts.retentionCount) : null,
      enabled: !opts.disabled,
    });
    console.log(JSON.stringify(t, null, 2));
  });

program
  .command('vault:backup-target:list')
  .action(() => {
    const ctx = buildContext();
    console.log(JSON.stringify(ctx.vaultBackupTargetsRepo.list(), null, 2));
  });

program
  .command('vault:backup-target:add-drive')
  .description('Add a Google Drive destination for the .arkvault backup. Authorize it with vault:backup-target:authorize.')
  .requiredOption('--remote-path <path>', 'destination folder inside the Drive account, e.g. "Arkode/Vault"')
  .option('--label <text>', 'display label, e.g. the account e-mail')
  .option('--retention-count <n>', 'keep only the newest N .arkvault files there')
  .option('--disabled', 'add it disabled', false)
  .action((opts) => {
    const ctx = buildContext();
    const t = ctx.vaultBackupTargetsRepo.createGoogleDrive({
      remotePath: opts.remotePath,
      label: opts.label ?? null,
      retentionCount: opts.retentionCount != null ? Number(opts.retentionCount) : null,
      enabled: !opts.disabled,
    });
    console.log(JSON.stringify(t, null, 2));
  });

program
  .command('vault:backup-target:authorize')
  .description('Connect a Google account to a Drive vault-backup destination. Opens a browser, or pass --token from `rclone authorize "drive"` on another machine.')
  .argument('<targetId>')
  .option('--token <json>', 'the OAuth token blob from `rclone authorize "drive"` (headless fallback)')
  .action(async (targetId: string, opts) => {
    const ctx = buildContext();
    const target = ctx.vaultBackupTargetsRepo.getById(targetId);
    if (!target || target.kind !== 'google_drive' || !target.rcloneConfigSecretRef) {
      console.error('Not a Google Drive vault-backup destination.');
      process.exitCode = 1;
      return;
    }
    const token = opts.token
      ? (rcloneClient.extractTokenBlob(opts.token) ?? String(opts.token).trim())
      : await rcloneClient.rcloneAuthorizeDrive({});
    JSON.parse(token); // validate
    ctx.secretStore.set(target.rcloneConfigSecretRef, JSON.stringify({ token } satisfies RcloneDriveConfig));
    console.log('Connected.');
  });

program
  .command('vault:backup-target:test')
  .description('Check connectivity/auth for a Google Drive vault-backup destination.')
  .argument('<targetId>')
  .action(async (targetId: string) => {
    const ctx = buildContext();
    const target = ctx.vaultBackupTargetsRepo.getById(targetId);
    if (!target || target.kind !== 'google_drive' || !target.rcloneConfigSecretRef) {
      console.error('Not a Google Drive vault-backup destination.');
      process.exitCode = 1;
      return;
    }
    const raw = ctx.secretStore.get(target.rcloneConfigSecretRef);
    if (!raw) {
      console.error('Not connected — run vault:backup-target:authorize first.');
      process.exitCode = 1;
      return;
    }
    try {
      const drive = JSON.parse(raw) as RcloneDriveConfig;
      const out = await rcloneClient.withRcloneConfig(
        { encryptWithCrypt: false },
        { provider: 'rclone_drive', drive },
        undefined,
        (configPath, remoteSection) => rcloneClient.rcloneAbout({ configPath, remoteSection })
      );
      console.log(out);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

program
  .command('vault:backup-target:rm')
  .argument('<targetId>')
  .action((targetId: string) => {
    const ctx = buildContext();
    ctx.vaultBackupTargetsRepo.remove(targetId);
    console.log('Removed.');
  });

program
  .command('vault:backup')
  .description('Write the full encrypted .arkvault (whole operational state + every secret) to every configured destination, or to --output. Prompts for the master password.')
  .option('--output <file>', 'write a single .arkvault to this exact path instead of the configured targets')
  .action(async (opts) => {
    const ctx = buildContext();
    if (!(await unlockVaultForCli(ctx))) {
      process.exitCode = 1;
      return;
    }
    if (opts.output) {
      const buf = exportVaultBuffer(buildVaultBackupDeps(ctx));
      await writeFile(opts.output, buf);
      console.log(`Wrote ${buf.length} bytes to ${opts.output}`);
      return;
    }
    const result = await runAllVaultBackups(buildVaultBackupDeps(ctx));
    console.log(JSON.stringify(result, null, 2));
    if (!result.allOk) process.exitCode = 1;
  });

program
  .command('vault:restore')
  .description('Rebuild Arkode from an .arkvault into a FRESH install: clients, connections, tasks, schedules, restic keys, replication config, SSH keys and all secrets. Prompts for the master password.')
  .requiredOption('--file <path>')
  .action(async (opts) => {
    const ctx = buildContext();
    if (ctx.vaultState.isInitialized()) {
      console.error('This machine already has a vault. Restore is only supported into a fresh install.');
      process.exitCode = 1;
      return;
    }
    const buf = await readFile(opts.file);
    try {
      const info = inspectVaultBuffer(buf);
      console.log(`Backup created ${info.createdAt} (format v${info.formatVersion}).`);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
      return;
    }
    const password = await promptPassword('Master password for this backup: ');
    try {
      const result = importVaultBuffer(buildVaultBackupDeps(ctx), buf, password);
      console.log(JSON.stringify(result, null, 2));
      if (result.warnings.length > 0) {
        console.log('\nWarnings:');
        for (const w of result.warnings) console.log(`  - ${w}`);
      }
      console.log(
        '\nRestored. The arkode-scheduler service picks up the schedules on its next tick. ' +
          'Re-register per-task Windows Scheduled Tasks only if you used the legacy model.'
      );
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

// --- Arkode Pocket (read-only mobile credential viewer) ---------------------
// See docs/pocket.md. Deliberately a small, separate command surface —
// mirrors the vault:backup-target:* commands' shape (configure once, connect
// Drive, then publish/pair/revoke), never touching any backup-domain code.

program
  .command('pocket:configure')
  .description('Configure (or reconfigure) Arkode Pocket: the Google Drive folder its snapshot is published to. Generates the Pocket device key on first use.')
  .requiredOption('--drive-remote-path <path>', 'e.g. "Arkode/Pocket"')
  .action((opts) => {
    const ctx = buildContext();
    const state = configurePocket({ pocketStateRepo: ctx.pocketStateRepo, secretStore: ctx.secretStore }, { driveRemotePath: opts.driveRemotePath });
    console.log(JSON.stringify(state, null, 2));
  });

program
  .command('pocket:status')
  .description('Show Arkode Pocket configuration/publish status.')
  .action(() => {
    const ctx = buildContext();
    const state = ctx.pocketStateRepo.get();
    console.log(
      JSON.stringify(
        { ...state, driveConnected: isPocketDriveConnected(ctx.secretStore), vaultUnlocked: ctx.vaultState.isUnlocked() },
        null,
        2
      )
    );
  });

program
  .command('pocket:enable')
  .action(() => {
    const ctx = buildContext();
    console.log(JSON.stringify(setPocketEnabled({ pocketStateRepo: ctx.pocketStateRepo, secretStore: ctx.secretStore }, true), null, 2));
  });

program
  .command('pocket:disable')
  .action(() => {
    const ctx = buildContext();
    console.log(JSON.stringify(setPocketEnabled({ pocketStateRepo: ctx.pocketStateRepo, secretStore: ctx.secretStore }, false), null, 2));
  });

program
  .command('pocket:connect-drive')
  .description('Connect a Google account for Arkode Pocket to publish to. Opens a browser, or pass --token from `rclone authorize "drive"` on another machine.')
  .option('--token <json>', 'the OAuth token blob from `rclone authorize "drive"` (headless fallback)')
  .action(async (opts) => {
    const ctx = buildContext();
    const token = opts.token ? (rcloneClient.extractTokenBlob(opts.token) ?? String(opts.token).trim()) : await rcloneClient.rcloneAuthorizeDrive({});
    JSON.parse(token); // validate
    setPocketDriveToken(ctx.secretStore, JSON.stringify({ token } satisfies RcloneDriveConfig));
    console.log('Connected.');
  });

program
  .command('pocket:test-drive')
  .description('Check connectivity/auth for Arkode Pocket\'s Google Drive account.')
  .action(async () => {
    const ctx = buildContext();
    const drive = getPocketDriveConfig(ctx.secretStore);
    if (!drive) {
      console.error('Not connected — run pocket:connect-drive first.');
      process.exitCode = 1;
      return;
    }
    try {
      const out = await rcloneClient.withRcloneConfig(
        { encryptWithCrypt: false },
        { provider: 'rclone_drive', drive },
        undefined,
        (configPath, remoteSection) => rcloneClient.rcloneAbout({ configPath, remoteSection })
      );
      console.log(out);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

program
  .command('pocket:pair')
  .description('Print the pairing payload for "Vincular dispositivo" — encode this JSON as a QR in the UI. Does NOT mark any device as connected (Desktop cannot know that — see docs/pocket.md).')
  .option('--label <name>', 'an optional label for your own reference, e.g. "Pablo Pixel"')
  .action(async (opts) => {
    const ctx = buildContext();
    try {
      // See the matching comment on POST /pocket/pairing: publish first
      // whenever dirty (e.g. right after pocket:revoke) so the DEK this
      // payload carries always matches what's actually live on Drive.
      if (ctx.pocketStateRepo.get()?.dirty) {
        const publishResult = await runPocketPublish(buildPocketPublishDeps(ctx));
        if (publishResult.status === 'failed') {
          console.error(`Could not publish the current state before pairing (${publishResult.error ?? 'unknown error'}). Fix that first.`);
          process.exitCode = 1;
          return;
        }
      }
      const payload = generatePocketPairingPayload({ pocketStateRepo: ctx.pocketStateRepo, secretStore: ctx.secretStore }, opts.label);
      console.log(JSON.stringify(payload));
      console.error('\nThis payload grants read access to every Arkode Pocket snapshot published from now on. Treat it like a password — do not log or share it beyond the pairing QR.');
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

program
  .command('pocket:publish')
  .description('Publish the current Pocket snapshot now (requires the vault unlocked).')
  .option('--force', 'publish even if not dirty')
  .action(async (opts) => {
    const ctx = buildContext();
    if (!(await unlockVaultForCli(ctx))) {
      process.exitCode = 1;
      return;
    }
    const result = await runPocketPublish(buildPocketPublishDeps(ctx), { force: opts.force === true });
    console.log(JSON.stringify(result, null, 2));
    if (result.status === 'failed') process.exitCode = 1;
  });

program
  .command('pocket:revoke')
  .description('Revoke the current Pocket pairing: rotates the device key so no snapshot published from now on can be opened by whatever device holds the old key. Does NOT erase data the device already downloaded, sign it out of Google, or invalidate passwords it already saw.')
  .action(async () => {
    const ctx = buildContext();
    const state = await revokePocketDevice({ pocketStateRepo: ctx.pocketStateRepo, secretStore: ctx.secretStore });
    console.log(JSON.stringify(state, null, 2));
    console.log('\nRevoked. Run pocket:pair to generate a new pairing code for the next device.');
  });

program
  .command('db-tools:detect')
  .description('Scan the usual Windows install locations (Program Files, WAMP/XAMPP/Laragon) for pg_dump/psql/mysqldump/mysql/mariadb-dump/mariadb and print what was found, with versions.')
  .action(async () => {
    console.log(JSON.stringify(await detectInstalledDbTools(), null, 2));
  });

program
  .command('pg-tools:register')
  .description(
    'Register a pg_dump/pg_restore pair for a specific PostgreSQL major version (e.g. "18", "15", or "9.6"), so direct_dump picks a version-matched pg_dump instead of always using PG_DUMP_PATH. Requires PSQL_PATH to be set for version-aware selection to actually kick in — see CLAUDE.md.'
  )
  .requiredOption('--pg-version <majorVersion>', 'PostgreSQL major version this pair targets, e.g. "18" or "9.6"')
  .requiredOption('--pg-dump-path <path>', 'Path to the pg_dump.exe matching this version')
  .requiredOption('--pg-restore-path <path>', 'Path to the pg_restore.exe matching this version')
  .action((opts) => {
    const ctx = buildContext();
    const registry = createPostgresToolRegistry(ctx.settingsRepo);
    registry.register(opts.pgVersion, { pgDumpPath: opts.pgDumpPath, pgRestorePath: opts.pgRestorePath });
    console.log(`Registered PostgreSQL ${opts.pgVersion}: ${opts.pgDumpPath}`);
  });

program
  .command('pg-tools:list')
  .description('List every registered PostgreSQL major-version → pg_dump/pg_restore path pair.')
  .action(() => {
    const ctx = buildContext();
    const registry = createPostgresToolRegistry(ctx.settingsRepo);
    console.log(JSON.stringify(registry.list(), null, 2));
  });

program
  .command('pg-tools:unregister')
  .description('Remove a registered PostgreSQL major version, if present.')
  .requiredOption('--pg-version <majorVersion>')
  .action((opts) => {
    const ctx = buildContext();
    const registry = createPostgresToolRegistry(ctx.settingsRepo);
    registry.unregister(opts.pgVersion);
    console.log(`Unregistered PostgreSQL ${opts.pgVersion} (if it was registered).`);
  });

program
  .command('pg-tools:download')
  .description(
    'Download a real pg_dump/pg_restore/psql set from EnterpriseDB and register it for a PostgreSQL major version, instead of pointing pg-tools:register at a manually-installed copy. Needs the *exact* EDB release version (major.minor-buildrevision, e.g. "18.6-1") to build a real download URL -- this is not guessed from the major version alone.'
  )
  .requiredOption('--pg-version <majorVersion>', 'the major version to register the result under, e.g. "18"')
  .requiredOption('--exact-version <exactVersion>', 'EDB\'s exact release version, e.g. "18.6-1" -- see enterprisedb.com/download-postgresql-binaries')
  .action(async (opts) => {
    const ctx = buildContext();
    const destDir = vendoredToolsDir('postgres', opts.pgVersion);
    console.log(`Downloading PostgreSQL ${opts.exactVersion} client tools...`);
    const paths = (await downloadTool({ engine: 'postgres', exactVersion: opts.exactVersion, destDir })) as { pgDumpPath: string; pgRestorePath: string };
    createPostgresToolRegistry(ctx.settingsRepo).register(opts.pgVersion, paths);
    console.log(`Downloaded and registered PostgreSQL ${opts.pgVersion}: ${paths.pgDumpPath}`);
  });

program
  .command('mysql-tools:register')
  .description(
    'Register a mysqldump path for a specific MySQL major.minor version (e.g. "8.0", "9.1"), so direct_dump picks a version-matched mysqldump instead of always using MYSQLDUMP_PATH. Requires MYSQL_CLI_PATH to be set for version-aware selection to actually kick in — see CLAUDE.md.'
  )
  .requiredOption('--mysql-version <majorMinorVersion>', 'MySQL major.minor version this path targets, e.g. "8.0" or "9.1"')
  .requiredOption('--mysqldump-path <path>', 'Path to the mysqldump.exe matching this version')
  .action((opts) => {
    const ctx = buildContext();
    const registry = createMysqlToolRegistry(ctx.settingsRepo);
    registry.register(opts.mysqlVersion, { mysqldumpPath: opts.mysqldumpPath });
    console.log(`Registered MySQL ${opts.mysqlVersion}: ${opts.mysqldumpPath}`);
  });

program
  .command('mysql-tools:list')
  .description('List every registered MySQL major.minor-version → mysqldump path.')
  .action(() => {
    const ctx = buildContext();
    const registry = createMysqlToolRegistry(ctx.settingsRepo);
    console.log(JSON.stringify(registry.list(), null, 2));
  });

program
  .command('mysql-tools:unregister')
  .description('Remove a registered MySQL major.minor version, if present.')
  .requiredOption('--mysql-version <majorMinorVersion>')
  .action((opts) => {
    const ctx = buildContext();
    const registry = createMysqlToolRegistry(ctx.settingsRepo);
    registry.unregister(opts.mysqlVersion);
    console.log(`Unregistered MySQL ${opts.mysqlVersion} (if it was registered).`);
  });

program
  .command('mariadb-tools:register')
  .description(
    'Register a mariadb-dump path for a specific MariaDB major.minor version (e.g. "10.11", "11.5"), so direct_dump picks a version-matched mariadb-dump instead of always using MARIADB_DUMP_PATH. Requires MYSQL_CLI_PATH to be set for version-aware selection to actually kick in — see CLAUDE.md.'
  )
  .requiredOption('--mariadb-version <majorMinorVersion>', 'MariaDB major.minor version this path targets, e.g. "10.11" or "11.5"')
  .requiredOption('--mariadb-dump-path <path>', 'Path to the mariadb-dump.exe matching this version')
  .action((opts) => {
    const ctx = buildContext();
    const registry = createMariaDbToolRegistry(ctx.settingsRepo);
    registry.register(opts.mariadbVersion, { mariaDbDumpPath: opts.mariadbDumpPath });
    console.log(`Registered MariaDB ${opts.mariadbVersion}: ${opts.mariadbDumpPath}`);
  });

program
  .command('mariadb-tools:list')
  .description('List every registered MariaDB major.minor-version → mariadb-dump path.')
  .action(() => {
    const ctx = buildContext();
    const registry = createMariaDbToolRegistry(ctx.settingsRepo);
    console.log(JSON.stringify(registry.list(), null, 2));
  });

program
  .command('mariadb-tools:unregister')
  .description('Remove a registered MariaDB major.minor version, if present.')
  .requiredOption('--mariadb-version <majorMinorVersion>')
  .action((opts) => {
    const ctx = buildContext();
    const registry = createMariaDbToolRegistry(ctx.settingsRepo);
    registry.unregister(opts.mariadbVersion);
    console.log(`Unregistered MariaDB ${opts.mariadbVersion} (if it was registered).`);
  });

program
  .command('mariadb-tools:download')
  .description(
    "Download a real mariadb-dump from MariaDB's own archive and register it for a MariaDB major.minor version, instead of pointing mariadb-tools:register at a manually-installed copy. Needs the *exact* release version (major.minor.patch, e.g. \"11.5.2\") to build a real download URL."
  )
  .requiredOption('--mariadb-version <majorMinorVersion>', 'the major.minor version to register the result under, e.g. "11.5"')
  .requiredOption('--exact-version <exactVersion>', 'MariaDB\'s exact release version, e.g. "11.5.2" -- see archive.mariadb.org')
  .action(async (opts) => {
    const ctx = buildContext();
    const destDir = vendoredToolsDir('mariadb', opts.mariadbVersion);
    console.log(`Downloading MariaDB ${opts.exactVersion} client tools...`);
    const paths = (await downloadTool({ engine: 'mariadb', exactVersion: opts.exactVersion, destDir })) as { mariaDbDumpPath: string };
    createMariaDbToolRegistry(ctx.settingsRepo).register(opts.mariadbVersion, paths);
    console.log(`Downloaded and registered MariaDB ${opts.mariadbVersion}: ${paths.mariaDbDumpPath}`);
  });

// === File backups (restic-backed) — a domain parallel to the DB-backup
// commands above, deliberately not sharing logic with them. See
// CLAUDE.md's file-backup design notes. ===

/** Shared by the file-task:run CLI command and the serve HTTP endpoint. */
function buildFileBackupTaskDeps(ctx: ReturnType<typeof buildContext>): RunFileBackupTaskDeps {
  return {
    clientsRepo: ctx.clientsRepo,
    transportsRepo: ctx.transportsRepo,
    knownHostsRepo: ctx.knownHostsRepo,
    fileBackupRepositoriesRepo: ctx.fileBackupRepositoriesRepo,
    fileBackupRunsRepo: ctx.fileBackupRunsRepo,
    fileBackupMaintenanceRunsRepo: ctx.fileBackupMaintenanceRunsRepo,
    fileBackupRetentionDeletionsRepo: ctx.fileBackupRetentionDeletionsRepo,
    fileBackupLogEventsRepo: ctx.fileBackupLogEventsRepo,
    secretStore: ctx.secretStore,
    // Mirrors runTaskNow's exact DB-domain pattern — confirmHostInteractively
    // itself is what correctly (and intentionally) rejects an unknown host
    // when there's no real interactive terminal to confirm in (run-due,
    // serve), not a caller-specific branch here.
    onUnknownHost: confirmHostInteractively,
    onProgress: ctx.fileProgressSink,
  };
}

function runFileBackupTaskNow(ctx: ReturnType<typeof buildContext>, task: FileBackupTask) {
  return runFileBackupTask(task, buildFileBackupTaskDeps(ctx));
}

/** Shared by `replication:*` CLI commands, the serve HTTP endpoints, and the scheduler tick. */
function buildReplicationDeps(ctx: ReturnType<typeof buildContext>): ReplicateTargetDeps & ReplicationDueDeps {
  return {
    replicationTargetsRepo: ctx.replicationTargetsRepo,
    replicationRunsRepo: ctx.replicationRunsRepo,
    clientsRepo: ctx.clientsRepo,
    fileBackupRepositoriesRepo: ctx.fileBackupRepositoriesRepo,
    fileBackupRunsRepo: ctx.fileBackupRunsRepo,
    fileBackupMaintenanceRunsRepo: ctx.fileBackupMaintenanceRunsRepo,
    transportsRepo: ctx.transportsRepo,
    secretStore: ctx.secretStore,
    runsRepo: ctx.runsRepo,
  };
}

/** Deps for the vault reuse-bridge (Tier 2 credential -> Tier 1 operational copy). */
function buildVaultSyncDeps(ctx: ReturnType<typeof buildContext>): SyncOperationalCopyDeps {
  return {
    db: ctx.db,
    vaultCredentialsRepo: ctx.vaultCredentialsRepo,
    vaultSecretStore: ctx.vaultSecretStore,
    transportsRepo: ctx.transportsRepo,
    databaseConnectionsRepo: ctx.databaseConnectionsRepo,
    secretStore: ctx.secretStore,
  };
}

/** Deps for Arkode Pocket's publish pipeline. */
function buildPocketPublishDeps(ctx: ReturnType<typeof buildContext>): RunPocketPublishDeps {
  return {
    pocketStateRepo: ctx.pocketStateRepo,
    secretStore: ctx.secretStore,
    vaultState: ctx.vaultState,
    clientsRepo: ctx.clientsRepo,
    vaultCredentialsRepo: ctx.vaultCredentialsRepo,
    vaultUrlsRepo: ctx.vaultUrlsRepo,
    vaultSecretStore: ctx.vaultSecretStore,
  };
}

/** JSON shape for GET /pocket/status and every mutating Pocket endpoint's response. */
function pocketStatusJson(ctx: ReturnType<typeof buildContext>) {
  const state: PocketState | null = ctx.pocketStateRepo.get();
  return {
    configured: state?.configured ?? false,
    enabled: state?.enabled ?? true,
    driveConnected: isPocketDriveConnected(ctx.secretStore),
    driveRemotePath: state?.driveRemotePath ?? null,
    dirty: state?.dirty ?? false,
    lastAttemptedRevision: state?.lastAttemptedRevision ?? null,
    lastConfirmedRevision: state?.lastConfirmedRevision ?? null,
    lastAttemptAt: state?.lastAttemptAt ?? null,
    lastSuccessfulPublishAt: state?.lastSuccessfulPublishAt ?? null,
    lastError: state?.lastError ?? null,
    deviceLabel: state?.deviceLabel ?? null,
    pairedAt: state?.pairedAt ?? null,
    revokedAt: state?.revokedAt ?? null,
    vaultUnlocked: ctx.vaultState.isUnlocked(),
  };
}

/** Deps for portable .arkvault export/import/backup. */
function buildVaultBackupDeps(ctx: ReturnType<typeof buildContext>): RunVaultBackupDeps {
  return {
    db: ctx.db,
    vaultMetaRepo: ctx.vaultMetaRepo,
    vaultState: ctx.vaultState,
    vaultSecretStore: ctx.vaultSecretStore,
    secretStore: ctx.secretStore,
    clientsRepo: ctx.clientsRepo,
    backupSetsRepo: ctx.backupSetsRepo,
    transportsRepo: ctx.transportsRepo,
    databaseConnectionsRepo: ctx.databaseConnectionsRepo,
    tasksRepo: ctx.tasksRepo,
    settingsRepo: ctx.settingsRepo,
    fileBackupRepositoriesRepo: ctx.fileBackupRepositoriesRepo,
    fileBackupTasksRepo: ctx.fileBackupTasksRepo,
    replicationTargetsRepo: ctx.replicationTargetsRepo,
    vaultCredentialsRepo: ctx.vaultCredentialsRepo,
    vaultUrlsRepo: ctx.vaultUrlsRepo,
    vaultItemsRepo: ctx.vaultItemsRepo,
    vaultBackupTargetsRepo: ctx.vaultBackupTargetsRepo,
    pocketStateRepo: ctx.pocketStateRepo,
  };
}

/** SecretStore refs for a replication target (deterministic, so re-authorizing overwrites in place). */
function replicationConfigSecretRef(clientId: string, content: ReplicationContent): string {
  return `replication:${clientId}:${content}:rclone-config`;
}
function replicationCryptSecretRef(clientId: string, content: ReplicationContent): string {
  return `replication:${clientId}:${content}:crypt-password`;
}

function mapMaintenanceOperationFlag(value: string | undefined): FileBackupMaintenanceOperation | 'all' | undefined {
  if (!value) return undefined;
  if (value === 'check-read-data') return 'check_read_data';
  return value as FileBackupMaintenanceOperation | 'all';
}

program
  .command('file-repo:create')
  .description(
    'Create the one restic repository a client\'s file-backup tasks share, at {client.localBasePath}\\_restic-repo. Prints the plaintext recovery key ONCE — save it somewhere outside this installation (file-repo:export-key re-shows it later, but recovery must never depend solely on this machine).'
  )
  .requiredOption('--client <clientId>')
  .action(async (opts) => {
    const ctx = buildContext();
    try {
      const { repository, recoveryKey } = await createFileBackupRepository(opts.client, {
        clientsRepo: ctx.clientsRepo,
        fileBackupRepositoriesRepo: ctx.fileBackupRepositoriesRepo,
        secretStore: ctx.secretStore,
      });
      console.log(JSON.stringify(repository, null, 2));
      console.error(`\nRECOVERY KEY (guardala fuera de esta PC — es indispensable para recuperar estos backups si esta instalación se pierde):\n${recoveryKey}\n`);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

program
  .command('file-repo:export-key')
  .description("Re-display a file-backup repository's plaintext recovery key.")
  .requiredOption('--client <clientId>')
  .action((opts) => {
    const ctx = buildContext();
    const repository = ctx.fileBackupRepositoriesRepo.getByClientId(opts.client);
    if (!repository) {
      console.error(`Client ${opts.client} has no file-backup repository yet — create one with file-repo:create.`);
      process.exitCode = 1;
      return;
    }
    try {
      const key = exportFileBackupRepositoryKey(repository.id, ctx);
      console.log(key);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

program
  .command('file-repo:unlock')
  .description("Clear a stale restic lock on a client's file-backup repository (restic itself only removes locks it can prove are dead — this is safe). Normally not needed: a lock left by a run killed mid-restic is cleared automatically on the next run.")
  .requiredOption('--client <clientId>')
  .action(async (opts) => {
    const ctx = buildContext();
    const repository = ctx.fileBackupRepositoriesRepo.getByClientId(opts.client);
    if (!repository) {
      console.error(`Client ${opts.client} has no file-backup repository yet — create one with file-repo:create.`);
      process.exitCode = 1;
      return;
    }
    const password = ctx.secretStore.get(repository.passwordSecretRef);
    if (!password) {
      console.error(`Could not resolve the password for file-backup repository ${repository.id}.`);
      process.exitCode = 1;
      return;
    }
    try {
      await resticClient.unlockRepository(repository.repoPath, password);
      console.log(`Cleared any stale lock on ${repository.repoPath}.`);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

program
  .command('file-repo:run-maintenance')
  .description(
    'Run repository maintenance (prune/check) — never run as part of a normal backup. With no options, sweeps every repository and runs whatever is due per its own cadence (prune weekly, check monthly). --operation forces a specific operation regardless of cadence.'
  )
  .option('--repo <repositoryId>', 'target just this one repository instead of every repository')
  .option('--operation <prune|check|check-read-data|all>', 'force this operation regardless of due-cadence')
  .action(async (opts) => {
    const ctx = buildContext();
    const outcomes = await runFileBackupMaintenance(
      { fileBackupRepositoriesRepo: ctx.fileBackupRepositoriesRepo, fileBackupMaintenanceRunsRepo: ctx.fileBackupMaintenanceRunsRepo, fileBackupRunsRepo: ctx.fileBackupRunsRepo, secretStore: ctx.secretStore },
      { repositoryId: opts.repo, operation: mapMaintenanceOperationFlag(opts.operation) }
    );
    console.log(JSON.stringify(outcomes, null, 2));
    if (outcomes.some((o) => o.error)) process.exitCode = 1;
  });

program
  .command('file-repo:scheduler:install-maintenance')
  .description('Register the one global Windows Scheduled Task that sweeps every file-backup repository for due maintenance. Runs as SYSTEM; must be run elevated.')
  .action(async () => {
    await installScheduledTask({
      taskName: FILE_BACKUP_MAINTENANCE_TASK_NAME,
      description: 'arkode - file-backup repository maintenance sweep (prune/check)',
      scheduleTime: '04:00',
      command: process.execPath,
      arguments: Boolean((process as NodeJS.Process & { pkg?: unknown }).pkg) ? 'file-repo:run-maintenance' : `"${process.argv[1]}" file-repo:run-maintenance`,
    });
    console.log(`Registered Windows Scheduled Task "${FILE_BACKUP_MAINTENANCE_TASK_NAME}", running as SYSTEM.`);
  });

program
  .command('file-repo:scheduler:uninstall-maintenance')
  .description('Remove the global file-backup maintenance Scheduled Task.')
  .action(async () => {
    await uninstallScheduledTask(FILE_BACKUP_MAINTENANCE_TASK_NAME);
    console.log(`Removed Windows Scheduled Task "${FILE_BACKUP_MAINTENANCE_TASK_NAME}".`);
  });

program
  .command('file-repo:scheduler:status-maintenance')
  .description('Check whether the global file-backup maintenance Scheduled Task is registered.')
  .action(async () => {
    const status = await scheduledTaskStatus(FILE_BACKUP_MAINTENANCE_TASK_NAME);
    console.log(JSON.stringify(status, null, 2));
    if (!status.exists) process.exitCode = 1;
  });

program
  .command('file-task:create')
  .description(
    'Create a file-backup task (local_folder by default, or --source-kind remote_folder). The client must already have a file-backup repository (file-repo:create).'
  )
  .requiredOption('--client <clientId>')
  .requiredOption('--name <name>')
  .option('--source-kind <local_folder|remote_folder>', 'defaults to local_folder', 'local_folder')
  .option('--source-path <path>', 'required for local_folder — the folder to back up, resolved to an absolute path before use')
  .option('--transport <transportId>', 'required for remote_folder — must be an sftp or ftp transport')
  .option('--remote-source-path <path>', 'required for remote_folder — the folder\'s path on the remote host')
  .option('--retention-count <n>')
  .option('--retention-days <n>')
  .option('--backup-set <backupSetId>', 'optional — a pure visual/reporting label grouping this task with others')
  .action((opts) => {
    const ctx = buildContext();
    const repository = ctx.fileBackupRepositoriesRepo.getByClientId(opts.client);
    if (!repository) {
      console.error(`Client ${opts.client} has no file-backup repository yet — create one with file-repo:create.`);
      process.exitCode = 1;
      return;
    }
    try {
      const retentionCount = opts.retentionCount != null ? Number(opts.retentionCount) : null;
      const retentionDays = opts.retentionDays != null ? Number(opts.retentionDays) : null;
      const backupSetId = opts.backupSet ?? null;
      let task;
      if (opts.sourceKind === 'remote_folder') {
        if (!opts.transport || !opts.remoteSourcePath) {
          console.error('remote_folder tasks require --transport <id> and --remote-source-path <path>.');
          process.exitCode = 1;
          return;
        }
        task = ctx.fileBackupTasksRepo.createRemoteFolder({
          clientId: opts.client,
          repositoryId: repository.id,
          name: opts.name,
          transportId: opts.transport,
          remoteSourcePath: opts.remoteSourcePath,
          retentionCount,
          retentionDays,
          backupSetId,
        });
      } else {
        if (!opts.sourcePath) {
          console.error('local_folder tasks require --source-path <path>.');
          process.exitCode = 1;
          return;
        }
        task = ctx.fileBackupTasksRepo.createLocalFolder({
          clientId: opts.client,
          repositoryId: repository.id,
          name: opts.name,
          sourcePath: resolvePath(opts.sourcePath),
          retentionCount,
          retentionDays,
          backupSetId,
        });
      }
      console.log(JSON.stringify(task, null, 2));
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

program
  .command('file-task:update')
  .description("Update a file-backup task's name/retention (not its source folder — create a new task to point at a different one).")
  .argument('<taskId>')
  .option('--name <name>')
  .option('--retention-count <n>')
  .option('--retention-days <n>')
  .option('--backup-set <backupSetId>', 'assign/reassign this task to a backup set')
  .option('--clear-backup-set', 'unassign this task from its backup set', false)
  .action((taskId: string, opts) => {
    const ctx = buildContext();
    const task = ctx.fileBackupTasksRepo.update(taskId, {
      name: opts.name,
      retentionCount: opts.retentionCount != null ? Number(opts.retentionCount) : undefined,
      retentionDays: opts.retentionDays != null ? Number(opts.retentionDays) : undefined,
      backupSetId: opts.clearBackupSet ? null : opts.backupSet,
    });
    console.log(JSON.stringify(task, null, 2));
  });

program
  .command('file-task:deactivate')
  .argument('<taskId>')
  .action((taskId: string) => {
    const ctx = buildContext();
    ctx.fileBackupTasksRepo.deactivate(taskId);
    console.log(`Deactivated file-backup task ${taskId}.`);
  });

program
  .command('file-task:reactivate')
  .argument('<taskId>')
  .action((taskId: string) => {
    const ctx = buildContext();
    ctx.fileBackupTasksRepo.reactivate(taskId);
    console.log(`Reactivated file-backup task ${taskId}.`);
  });

program
  .command('file-task:list')
  .requiredOption('--client <clientId>')
  .action((opts) => {
    const ctx = buildContext();
    console.log(JSON.stringify(ctx.fileBackupTasksRepo.listByClient(opts.client), null, 2));
  });

program
  .command('file-task:test-connection')
  .description("Test a remote_folder file-backup task's transport, without running a sync/backup.")
  .argument('<taskId>')
  .action(async (taskId: string) => {
    const ctx = buildContext();
    const task = ctx.fileBackupTasksRepo.getById(taskId);
    if (!task) {
      console.error(`File-backup task ${taskId} not found.`);
      process.exitCode = 1;
      return;
    }
    if (task.sourceKind !== 'remote_folder' || !task.transportId) {
      console.error(`Task ${taskId} is a ${task.sourceKind} task — test-connection only applies to remote_folder.`);
      process.exitCode = 1;
      return;
    }
    const transport = ctx.transportsRepo.getById(task.transportId);
    if (!transport) {
      console.error(`Transport ${task.transportId} not found.`);
      process.exitCode = 1;
      return;
    }
    const result = await testTransportConnection(ctx, transport);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  });

program
  .command('file-task:run')
  .description('Run a file-backup task now (local_folder or remote_folder).')
  .argument('<taskId>')
  .action(async (taskId: string) => {
    const ctx = buildContext();
    const task = ctx.fileBackupTasksRepo.getById(taskId);
    if (!task) {
      console.error(`File-backup task ${taskId} not found.`);
      process.exitCode = 1;
      return;
    }
    try {
      const result = await runFileBackupTaskNow(ctx, task);
      console.log(JSON.stringify(result.run, null, 2));
      if (result.run.status === 'Failed') process.exitCode = 1;
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

program
  .command('file-task:run-due')
  .description('Run every currently-due scheduled file-backup task (or just one, with --task). What a file-backup task\'s Windows Scheduled Task actually invokes.')
  .option('--task <taskId>')
  .action(async (opts) => {
    const ctx = buildContext();
    let tasks: FileBackupTask[];
    if (opts.task) {
      const task = ctx.fileBackupTasksRepo.getById(opts.task);
      if (!task) {
        console.error(`File-backup task ${opts.task} not found.`);
        process.exitCode = 1;
        return;
      }
      tasks = [task];
    } else {
      tasks = ctx.fileBackupTasksRepo.listScheduled();
    }
    const results = await runFileBackupDueTasks(tasks, { ...buildFileBackupTaskDeps(ctx), fileBackupRunsRepo: ctx.fileBackupRunsRepo }, new Date());
    console.log(JSON.stringify(results, null, 2));
    if (results.some((r) => r.error || r.result?.run.status === 'Failed')) process.exitCode = 1;
  });

program
  .command('file-task:set-schedule')
  .argument('<taskId>')
  .option('--time <HH:MM>')
  .option('--disable', 'disable scheduling without clearing the configured time', false)
  .option('--frequency <daily|weekly|monthly>')
  .option('--days-of-week <list>', 'comma-separated 0 (Sunday) through 6 (Saturday)')
  .option('--day-of-month <n>', '1-31')
  .action((taskId: string, opts) => {
    const ctx = buildContext();
    const task = ctx.fileBackupTasksRepo.getById(taskId);
    if (!task) {
      console.error(`File-backup task ${taskId} not found.`);
      process.exitCode = 1;
      return;
    }
    if (!opts.time && !opts.disable) {
      console.error('Specify --time <HH:MM> and/or --disable.');
      process.exitCode = 1;
      return;
    }
    try {
      const updated = ctx.fileBackupTasksRepo.setSchedule(taskId, {
        scheduleTime: opts.time ?? task.scheduleTime,
        scheduleEnabled: !opts.disable,
        scheduleFrequency: opts.frequency,
        scheduleDaysOfWeek: opts.daysOfWeek ? opts.daysOfWeek.split(',').map(Number) : undefined,
        scheduleDayOfMonth: opts.dayOfMonth ? Number(opts.dayOfMonth) : undefined,
      });
      console.log(JSON.stringify(updated, null, 2));
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

program
  .command('file-task:scheduler:install')
  .description('Register a Windows Scheduled Task for a file-backup task, using its already-configured schedule. Runs as SYSTEM; must be run elevated.')
  .argument('<taskId>')
  .action(async (taskId: string) => {
    const ctx = buildContext();
    const task = ctx.fileBackupTasksRepo.getById(taskId);
    if (!task) {
      console.error(`File-backup task ${taskId} not found.`);
      process.exitCode = 1;
      return;
    }
    if (!task.scheduleEnabled || !task.scheduleTime) {
      console.error(`Task ${taskId} has no enabled schedule — set one first: file-task:set-schedule ${taskId} --time HH:MM`);
      process.exitCode = 1;
      return;
    }
    const taskName = scheduledTaskNameForFileBackupTask(taskId);
    const isPkgExe = Boolean((process as NodeJS.Process & { pkg?: unknown }).pkg);
    await installScheduledTask({
      taskName,
      description: `arkode - scheduled file-backup run for task "${task.name}"`,
      scheduleTime: task.scheduleTime,
      command: process.execPath,
      arguments: isPkgExe ? `file-task:run-due --task ${taskId}` : `"${process.argv[1]}" file-task:run-due --task ${taskId}`,
    });
    ctx.fileBackupTasksRepo.setWindowsTaskName(taskId, taskName);
    console.log(`Registered Windows Scheduled Task "${taskName}" for file-backup task "${task.name}" at ${task.scheduleTime} daily, running as SYSTEM.`);
  });

program
  .command('file-task:scheduler:uninstall')
  .argument('<taskId>')
  .action(async (taskId: string) => {
    const taskName = scheduledTaskNameForFileBackupTask(taskId);
    await uninstallScheduledTask(taskName);
    const ctx = buildContext();
    if (ctx.fileBackupTasksRepo.getById(taskId)) {
      ctx.fileBackupTasksRepo.setWindowsTaskName(taskId, null);
    }
    console.log(`Removed Windows Scheduled Task "${taskName}".`);
  });

program
  .command('file-task:scheduler:status')
  .argument('<taskId>')
  .action(async (taskId: string) => {
    const taskName = scheduledTaskNameForFileBackupTask(taskId);
    const status = await scheduledTaskStatus(taskName);
    console.log(JSON.stringify(status, null, 2));
    if (!status.exists) process.exitCode = 1;
  });

program
  .command('file-run:list')
  .option('--task <taskId>')
  .option('--client <clientId>')
  .action((opts) => {
    const ctx = buildContext();
    console.log(JSON.stringify(ctx.fileBackupRunsRepo.listRecent({ taskId: opts.task, clientId: opts.client }), null, 2));
  });

program
  .command('file-log:list')
  .description('List file-backup log_events (mirrors log:list for the DB-backup domain, backed by its own file_backup_log_events table).')
  .option('--search <term>')
  .option('--step <step>')
  .option('--level <debug|info|warn|error>')
  .option('--from <isoDate>')
  .option('--to <isoDate>')
  .option('--limit <n>')
  .option('--offset <n>')
  .action((opts) => {
    const ctx = buildContext();
    const result = ctx.fileBackupLogEventsRepo.listRecent({
      search: opts.search,
      step: opts.step,
      level: opts.level,
      from: opts.from,
      to: opts.to,
      limit: opts.limit != null ? Number(opts.limit) : undefined,
      offset: opts.offset != null ? Number(opts.offset) : undefined,
    });
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command('file-run:restore')
  .description("Restore a file-backup run's entire snapshot to a local folder.")
  .requiredOption('--run <runId>')
  .requiredOption('--target <dir>')
  .action(async (opts) => {
    const ctx = buildContext();
    try {
      const target = resolvePath(opts.target);
      await mkdir(target, { recursive: true });
      const result = await restoreFileBackupRun(opts.run, target, {
        fileBackupRunsRepo: ctx.fileBackupRunsRepo,
        fileBackupRepositoriesRepo: ctx.fileBackupRepositoriesRepo,
        secretStore: ctx.secretStore,
      });
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

program
  .command('file-run:delete')
  .description("Forget one specific snapshot (manual, not automated retention) — cheap and immediate, but doesn't reclaim disk space until the next prune.")
  .argument('<runId>')
  .action(async (runId: string) => {
    const ctx = buildContext();
    try {
      const result = await deleteFileBackupRun(runId, {
        fileBackupRunsRepo: ctx.fileBackupRunsRepo,
        fileBackupRepositoriesRepo: ctx.fileBackupRepositoriesRepo,
        fileBackupRetentionDeletionsRepo: ctx.fileBackupRetentionDeletionsRepo,
        fileBackupMaintenanceRunsRepo: ctx.fileBackupMaintenanceRunsRepo,
        secretStore: ctx.secretStore,
      });
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

program
  .command('file-run:restore-file')
  .description('Restore a single file from a file-backup run\'s snapshot.')
  .requiredOption('--run <runId>')
  .requiredOption('--path <absoluteSourcePath>', 'the file\'s original absolute path at backup time')
  .requiredOption('--target <destPath>', 'where to write the restored file')
  .action(async (opts) => {
    const ctx = buildContext();
    try {
      const dest = resolvePath(opts.target);
      await mkdir(resolvePath(dest, '..'), { recursive: true });
      await restoreFileBackupFile(opts.run, opts.path, dest, {
        fileBackupRunsRepo: ctx.fileBackupRunsRepo,
        fileBackupRepositoriesRepo: ctx.fileBackupRepositoriesRepo,
        secretStore: ctx.secretStore,
      });
      console.log(`Restored to ${dest}`);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

// === Off-site replication to Google Drive (rclone) — opt-in, per (client, content). ===

function parseReplicationContent(value: string): ReplicationContent {
  if (value === 'restic_repo' || value === 'db_dumps') return value;
  throw new Error(`--content must be "restic_repo" or "db_dumps", got "${value}"`);
}

/** Reads a target's crypt password from SecretStore, throwing a clear error if it's supposed to have one but doesn't. */
function loadReplicationCryptPassword(
  ctx: ReturnType<typeof buildContext>,
  target: { encryptWithCrypt: boolean; cryptPasswordSecretRef: string | null }
): string | undefined {
  if (!target.encryptWithCrypt) return undefined;
  const cryptPassword = target.cryptPasswordSecretRef
    ? (ctx.secretStore.get(target.cryptPasswordSecretRef) ?? undefined)
    : undefined;
  if (!cryptPassword) throw new Error('The encryption password for this target could not be read.');
  return cryptPassword;
}

/** Errors clearly when a Drive-only command (authorize/paste-token) is run against a non-Drive target. */
function requireDriveProvider(provider: ReplicationProvider): void {
  if (provider !== 'rclone_drive') {
    throw new Error('Esta replicación no usa Google Drive; no requiere autorización.');
  }
}

function parseReplicationProvider(value: string | undefined): ReplicationProvider {
  if (!value || value === 'drive') return 'rclone_drive';
  if (value === 'sftp') return 'rclone_sftp';
  if (value === 'ftp') return 'rclone_ftp';
  throw new Error(`--provider must be "drive", "sftp", or "ftp", got "${value}"`);
}

program
  .command('replication:add')
  .description('Configure an off-site copy of a client\'s backups. Opt-in, one per (client, content). --provider drive (default) needs replication:authorize next; --provider sftp/ftp reuses an existing Conexiones transport and is usable immediately.')
  .requiredOption('--client <clientId>')
  .requiredOption('--content <kind>', 'restic_repo | db_dumps')
  .requiredOption('--remote-path <path>', 'destination folder inside the remote, e.g. arkode/Winners/repo')
  .option('--provider <kind>', 'drive (default) | sftp | ftp')
  .option('--transport <transportId>', 'required for --provider sftp/ftp: an existing sftp/ftp transport for this client')
  .option('--no-encrypt', 'db_dumps only: sync raw instead of wrapping in an rclone crypt remote (NOT recommended — the destination would see plaintext dumps)')
  .option('--crypt-password <pw>', 'db_dumps only: supply the crypt password instead of generating one')
  .action(async (opts) => {
    const ctx = buildContext();
    try {
      const content = parseReplicationContent(opts.content);
      const provider = parseReplicationProvider(opts.provider);
      if (!ctx.clientsRepo.getById(opts.client)) throw new Error(`Client ${opts.client} not found.`);

      const encrypt = content === 'db_dumps' && opts.encrypt !== false;
      let cryptRef: string | null = null;
      let generated: string | null = null;
      if (encrypt) {
        cryptRef = replicationCryptSecretRef(opts.client, content);
        const pw = opts.cryptPassword ?? randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
        ctx.secretStore.set(cryptRef, pw);
        if (!opts.cryptPassword) generated = pw;
      }

      let transportId: string | undefined;
      let rcloneConfigSecretRef: string | undefined;
      if (provider === 'rclone_drive') {
        rcloneConfigSecretRef = replicationConfigSecretRef(opts.client, content);
      } else {
        if (!opts.transport) throw new Error('--transport is required for --provider sftp/ftp.');
        const transport = ctx.transportsRepo.getById(opts.transport);
        if (!transport || transport.clientId !== opts.client) {
          throw new Error(`Transport ${opts.transport} not found for client ${opts.client}.`);
        }
        const expectedType = provider === 'rclone_sftp' ? 'sftp' : 'ftp';
        if (transport.type !== expectedType) {
          throw new Error(`--provider ${provider === 'rclone_sftp' ? 'sftp' : 'ftp'} needs a "${expectedType}" transport, got "${transport.type}".`);
        }
        transportId = transport.id;
      }

      const target = ctx.replicationTargetsRepo.create({
        clientId: opts.client,
        content,
        provider,
        remotePath: opts.remotePath,
        rcloneConfigSecretRef,
        transportId,
        encryptWithCrypt: encrypt,
        cryptPasswordSecretRef: cryptRef,
      });
      console.log(JSON.stringify({ target, generatedCryptPassword: generated }, null, 2));
      if (generated) {
        console.log(
          '\n⚠  Save this encryption password somewhere safe OUTSIDE this machine — it is required to read these\n' +
            '   dumps back, and it is NOT included in a config export.'
        );
      }
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

program
  .command('replication:authorize')
  .description('Connect a Google account to a replication target via rclone\'s OAuth flow (opens a browser). Overwrites any previous authorization for this target.')
  .requiredOption('--client <clientId>')
  .requiredOption('--content <kind>', 'restic_repo | db_dumps')
  .option('--client-id <id>', 'your own Google OAuth client id (optional — avoids rclone\'s shared-client rate limits)')
  .option('--client-secret <secret>')
  .option('--no-open-browser', 'do not open a browser — just print the consent URL to open manually (must be on this machine)')
  .action(async (opts) => {
    const ctx = buildContext();
    try {
      const content = parseReplicationContent(opts.content);
      const target = ctx.replicationTargetsRepo.getByClientAndContent(opts.client, content);
      if (!target) throw new Error('No replication target for that client + content. Run `replication:add` first.');
      requireDriveProvider(target.provider);
      console.log(
        opts.openBrowser === false
          ? 'Starting Google sign-in… open the link below in any browser on this machine, approve access, then return here.'
          : 'Opening Google sign-in… approve access in the browser, then return here.'
      );
      const token = await rcloneClient.rcloneAuthorizeDrive({
        clientId: opts.clientId,
        clientSecret: opts.clientSecret,
        noOpenBrowser: opts.openBrowser === false,
        onAuthUrl: (url) => console.log(`\n  ${url}\n`),
      });
      const config: RcloneDriveConfig = { token };
      if (opts.clientId && opts.clientSecret) {
        config.clientId = opts.clientId;
        config.clientSecret = opts.clientSecret;
      }
      // requireDriveProvider() above + the repo's own create()-time validation guarantee this is set for a drive target.
      ctx.secretStore.set(target.rcloneConfigSecretRef!, JSON.stringify(config));
      console.log('Authorized. Run `replication:test` to verify.');
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

program
  .command('replication:paste-token')
  .description('Store a Google OAuth token obtained by running `rclone authorize "drive"` on another machine (headless-server fallback for replication:authorize).')
  .requiredOption('--client <clientId>')
  .requiredOption('--content <kind>', 'restic_repo | db_dumps')
  .requiredOption('--token <json>', 'the {"access_token":...} blob rclone printed')
  .action(async (opts) => {
    const ctx = buildContext();
    try {
      const content = parseReplicationContent(opts.content);
      const target = ctx.replicationTargetsRepo.getByClientAndContent(opts.client, content);
      if (!target) throw new Error('No replication target for that client + content. Run `replication:add` first.');
      requireDriveProvider(target.provider);
      const token = rcloneClient.extractTokenBlob(opts.token) ?? opts.token.trim();
      JSON.parse(token); // validate it parses
      ctx.secretStore.set(target.rcloneConfigSecretRef!, JSON.stringify({ token } satisfies RcloneDriveConfig));
      console.log('Token stored. Run `replication:test` to verify.');
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

program
  .command('replication:list')
  .description('List replication targets (all, or for one client), with last-run status.')
  .option('--client <clientId>')
  .action(async (opts) => {
    const ctx = buildContext();
    const targets = opts.client
      ? ctx.replicationTargetsRepo.listByClient(opts.client)
      : ctx.replicationTargetsRepo.listEnabled();
    console.log(
      JSON.stringify(
        targets.map((t) => ({
          ...t,
          due: isReplicationDue(t, buildReplicationDeps(ctx)),
        })),
        null,
        2
      )
    );
  });

program
  .command('replication:test <targetId>')
  .description('Check connectivity + auth for a target (rclone about — shows the account quota). Does not transfer anything.')
  .action(async (targetId) => {
    const ctx = buildContext();
    try {
      const target = ctx.replicationTargetsRepo.getById(targetId);
      if (!target) throw new Error(`Replication target ${targetId} not found.`);
      const remote = await resolveRcloneRemote(ctx, target);
      const cryptPassword = loadReplicationCryptPassword(ctx, target);
      const out = await rcloneClient.withRcloneConfig(target, remote, cryptPassword, (configPath, remoteSection) =>
        rcloneClient.rcloneAbout({ configPath, remoteSection })
      );
      console.log(out);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

program
  .command('replication:run <targetId>')
  .description('Replicate a target to Google Drive now (rclone sync). Same operation the scheduler runs after a successful backup.')
  .action(async (targetId) => {
    const ctx = buildContext();
    const result = await replicateTarget(buildReplicationDeps(ctx), targetId, { trigger: 'manual' });
    console.log(JSON.stringify(result, null, 2));
    if (result.status === 'Failed') process.exitCode = 1;
  });

program
  .command('replication:enable <targetId>')
  .description('Re-enable a disabled replication target.')
  .action(async (targetId) => {
    const ctx = buildContext();
    ctx.replicationTargetsRepo.update(targetId, { enabled: true });
    console.log(JSON.stringify(ctx.replicationTargetsRepo.getById(targetId)));
  });

program
  .command('replication:disable <targetId>')
  .description('Stop replicating a target (keeps its config + history; the remote copy is left as-is).')
  .action(async (targetId) => {
    const ctx = buildContext();
    ctx.replicationTargetsRepo.update(targetId, { enabled: false });
    console.log(JSON.stringify(ctx.replicationTargetsRepo.getById(targetId)));
  });

program
  .command('replication:remove <targetId>')
  .description('Delete a replication target and its run history (the remote Drive copy is NOT touched).')
  .action(async (targetId) => {
    const ctx = buildContext();
    ctx.replicationTargetsRepo.remove(targetId);
    console.log(JSON.stringify({ removed: targetId }));
  });

program
  .command('replication:runs')
  .description('Recent replication runs (all, or for one target).')
  .option('--target <targetId>')
  .option('--limit <n>', 'default 50')
  .action(async (opts) => {
    const ctx = buildContext();
    const limit = opts.limit ? Number(opts.limit) : 50;
    console.log(JSON.stringify(ctx.replicationRunsRepo.listRecent({ targetId: opts.target, limit }), null, 2));
  });

program
  .command('replication:pull <targetId>')
  .description('Disaster recovery: download a target\'s remote Drive copy to a local folder. For restic_repo, point `restic -r <dest>` at the result and restore normally.')
  .requiredOption('--dest <dir>')
  .action(async (targetId, opts) => {
    const ctx = buildContext();
    try {
      const target = ctx.replicationTargetsRepo.getById(targetId);
      if (!target) throw new Error(`Replication target ${targetId} not found.`);
      const remote = await resolveRcloneRemote(ctx, target);
      const cryptPassword = loadReplicationCryptPassword(ctx, target);
      const dest = resolvePath(opts.dest);
      await mkdir(dest, { recursive: true });
      await rcloneClient.withRcloneConfig(target, remote, cryptPassword, (configPath, remoteSection) =>
        rcloneClient.rcloneCopyDown({ configPath, remoteSection, remotePath: target.remotePath, destDir: dest })
      );
      console.log(`Pulled ${target.content} to ${dest}`);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

program
  .command('serve')
  .description(
    'Start a local HTTP server exposing dashboard status (GET /status) and per-task actions (run now, test connection) for the UI. Dev-only for now — see CLAUDE.md.'
  )
  .option('--port <port>', 'default 4287', '4287')
  .action((opts) => {
    const ctx = buildContext();
    const port = Number(opts.port);

    // This process is the app's whole backend — the UI talks to nothing
    // else. It must never die because one backup run threw where nothing
    // caught it (the concrete case: a remote FTP server dropping the
    // control connection mid-sync, which basic-ftp can surface as an
    // unhandled socket error). Log it, fail any run this process still
    // "owns" so it can't wedge a lock, and keep serving.
    function handleBackendFault(kind: string, err: unknown) {
      const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
      try {
        console.error(`[serve] ${kind} (kept alive): ${detail}`);
      } catch {
        /* ignore */
      }
      try {
        const stamp = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
        ctx.db
          .prepare(
            `UPDATE file_backup_runs SET status='Failed', finished_at=${stamp},
               error_message=COALESCE(error_message, ?) WHERE status IN ('Running','Producing','Validating') AND pid = ?`
          )
          .run(`Backend fault (${kind}) — run could not continue.`, process.pid);
        ctx.db
          .prepare(
            `UPDATE backup_runs SET status='Failed', finished_at=${stamp},
               error_message=COALESCE(error_message, ?) WHERE status IN ('Running','Producing','Validating') AND pid = ?`
          )
          .run(`Backend fault (${kind}) — run could not continue.`, process.pid);
      } catch {
        /* best-effort */
      }
    }
    process.on('unhandledRejection', (reason) => handleBackendFault('unhandledRejection', reason));
    process.on('uncaughtException', (err) => handleBackendFault('uncaughtException', err));

    function sendJson(res: ServerResponse, status: number, body: unknown) {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    }

    function readJsonBody(req: IncomingMessage): Promise<any> {
      return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', (chunk) => (data += chunk));
        req.on('end', () => {
          if (!data) return resolve({});
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error('Invalid JSON body.'));
          }
        });
        req.on('error', reject);
      });
    }

    // clientsRepo throws a plain Error for "not found" and duplicate-name — this is the
    // one place both meanings need distinct HTTP statuses (client actions elsewhere never confuse the two).
    function sendRepoError(res: ServerResponse, err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, /not found/i.test(message) ? 404 : 400, { error: message });
    }

    const server = createServer(async (req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*'); // dev-only: the UI runs on a different Vite port during development
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const url = new URL(req.url ?? '/', 'http://localhost');
      const pathname = url.pathname;

      if (req.method === 'GET' && pathname === '/status') {
        sendJson(res, 200, getDashboardStatus(ctx));
        return;
      }

      const actionMatch = req.method === 'POST' && pathname.match(/^\/tasks\/([^/]+)\/(run|test-connection|test-compatibility)$/);
      if (actionMatch) {
        const [, taskId, action] = actionMatch;
        const task = ctx.tasksRepo.getById(taskId);
        if (!task) {
          sendJson(res, 404, { error: `Task ${taskId} not found.` });
          return;
        }
        try {
          if (action === 'run') {
            const result = await runTaskNow(ctx, task);
            sendJson(res, 200, result.run);
          } else if (action === 'test-connection') {
            const body = await readJsonBody(req).catch(() => ({}));
            const result = await testTaskConnection(ctx, task, Boolean((body as { trustHost?: boolean }).trustHost));
            sendJson(res, result.ok ? 200 : 502, result);
          } else {
            const result = await testTaskCompatibility(ctx, task);
            sendJson(res, result.ok ? 200 : 502, result);
          }
        } catch (err) {
          sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      if (req.method === 'GET' && pathname === '/clients') {
        const includeInactive = url.searchParams.get('includeInactive') === 'true';
        const clients = (includeInactive ? ctx.clientsRepo.listAll() : ctx.clientsRepo.listActive()).map((client) => ({
          ...client,
          taskCount: ctx.tasksRepo.listByClient(client.id).length,
        }));
        sendJson(res, 200, clients);
        return;
      }

      if (req.method === 'POST' && pathname === '/clients') {
        try {
          const body = await readJsonBody(req);
          if (!body.name || !body.localBasePath) {
            sendJson(res, 400, { error: 'name and localBasePath are required.' });
            return;
          }
          const client = ctx.clientsRepo.create({
            name: body.name,
            description: body.description ?? null,
            localBasePath: body.localBasePath,
            retentionCount: body.retentionCount ?? null,
            retentionDays: body.retentionDays ?? null,
          });
          sendJson(res, 201, client);
        } catch (err) {
          sendRepoError(res, err);
        }
        return;
      }

      const setActiveMatch = req.method === 'POST' && pathname.match(/^\/clients\/([^/]+)\/(deactivate|reactivate)$/);
      if (setActiveMatch) {
        try {
          const [, clientId, action] = setActiveMatch;
          if (action === 'deactivate') ctx.clientsRepo.deactivate(clientId);
          else ctx.clientsRepo.reactivate(clientId);
          sendJson(res, 200, { ok: true });
        } catch (err) {
          sendRepoError(res, err);
        }
        return;
      }

      const clientIdMatch = req.method === 'PATCH' && pathname.match(/^\/clients\/([^/]+)$/);
      if (clientIdMatch) {
        try {
          const body = await readJsonBody(req);
          const client = ctx.clientsRepo.update(clientIdMatch[1], body);
          sendJson(res, 200, client);
        } catch (err) {
          sendRepoError(res, err);
        }
        return;
      }

      if (req.method === 'GET' && pathname === '/backup-sets') {
        const clientId = url.searchParams.get('client');
        if (!clientId) {
          sendJson(res, 400, { error: 'client is required.' });
          return;
        }
        const includeInactive = url.searchParams.get('includeInactive') === 'true';
        sendJson(res, 200, ctx.backupSetsRepo.listByClient(clientId, { includeInactive }));
        return;
      }

      if (req.method === 'POST' && pathname === '/backup-sets') {
        try {
          const body = await readJsonBody(req);
          if (!body.clientId || !body.name) {
            sendJson(res, 400, { error: 'clientId and name are required.' });
            return;
          }
          const set = ctx.backupSetsRepo.create({ clientId: body.clientId, name: body.name });
          sendJson(res, 201, set);
        } catch (err) {
          sendRepoError(res, err);
        }
        return;
      }

      const backupSetActiveMatch = req.method === 'POST' && pathname.match(/^\/backup-sets\/([^/]+)\/(deactivate|reactivate)$/);
      if (backupSetActiveMatch) {
        try {
          const [, backupSetId, action] = backupSetActiveMatch;
          if (action === 'deactivate') ctx.backupSetsRepo.deactivate(backupSetId);
          else ctx.backupSetsRepo.reactivate(backupSetId);
          sendJson(res, 200, { ok: true });
        } catch (err) {
          sendRepoError(res, err);
        }
        return;
      }

      const backupSetIdMatch = req.method === 'PATCH' && pathname.match(/^\/backup-sets\/([^/]+)$/);
      if (backupSetIdMatch) {
        try {
          const body = await readJsonBody(req);
          const set = ctx.backupSetsRepo.update(backupSetIdMatch[1], { name: body.name });
          sendJson(res, 200, set);
        } catch (err) {
          sendRepoError(res, err);
        }
        return;
      }

      if (req.method === 'GET' && pathname === '/connections') {
        const includeInactive = url.searchParams.get('includeInactive') === 'true';
        const clients = ctx.clientsRepo.listActive();
        const ownerOfTransport = (id: string) => ctx.vaultCredentialsRepo.getByLinkedTransportId(id);
        const ownerOfDbConn = (id: string) => ctx.vaultCredentialsRepo.getByLinkedDatabaseConnectionId(id);
        const transports = clients.flatMap((client) =>
          ctx.transportsRepo
            .listByClient(client.id)
            .filter((t) => includeInactive || t.isActive)
            .map((t) => {
              const owner = ownerOfTransport(t.id);
              return {
                ...t,
                clientName: client.name,
                credentialName: owner?.name ?? null,
                operationalSyncState: owner?.operationalSyncState ?? null,
              };
            })
        );
        const databaseConnections = clients.flatMap((client) =>
          ctx.databaseConnectionsRepo
            .listByClient(client.id)
            .filter((d) => includeInactive || d.isActive)
            .map((d) => {
              const owner = ownerOfDbConn(d.id);
              return {
                ...d,
                clientName: client.name,
                credentialName: owner?.name ?? null,
                operationalSyncState: owner?.operationalSyncState ?? null,
              };
            })
        );
        sendJson(res, 200, {
          clients: clients.map((c) => ({ id: c.id, name: c.name, retentionCount: c.retentionCount, retentionDays: c.retentionDays })),
          transports,
          databaseConnections,
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/transports') {
        try {
          const body = await readJsonBody(req);
          if (!body.clientId || !body.name || !body.host || !body.username) {
            sendJson(res, 400, { error: 'clientId, name, host, and username are required.' });
            return;
          }
          let transport;
          if (body.type === 'ftp') {
            transport = ctx.transportsRepo.createFtp({
              clientId: body.clientId,
              name: body.name,
              host: body.host,
              port: body.port,
              username: body.username,
              passwordSecretRef: resolveFtpPasswordSecretRef(ctx, body.password),
            });
          } else {
            if (!body.privateKeyPath) {
              sendJson(res, 400, { error: 'privateKeyPath is required for an sftp/ssh transport.' });
              return;
            }
            const passphraseSecretRef = resolvePassphraseSecretRef(ctx, body.passphrase);
            const privateKeyPath = await copyPrivateKeyIntoAppStorage(body.privateKeyPath);
            if (body.type === 'ssh') {
              transport = ctx.transportsRepo.createSsh({
                clientId: body.clientId,
                name: body.name,
                host: body.host,
                port: body.port,
                username: body.username,
                privateKeyPath,
                passphraseSecretRef,
              });
            } else {
              transport = ctx.transportsRepo.createSftp({
                clientId: body.clientId,
                name: body.name,
                host: body.host,
                port: body.port,
                username: body.username,
                privateKeyPath,
                passphraseSecretRef,
              });
            }
          }
          sendJson(res, 201, transport);
        } catch (err) {
          sendRepoError(res, err);
        }
        return;
      }

      const transportSetActiveMatch = req.method === 'POST' && pathname.match(/^\/transports\/([^/]+)\/(deactivate|reactivate)$/);
      if (transportSetActiveMatch) {
        try {
          const [, transportId, action] = transportSetActiveMatch;
          if (action === 'deactivate') ctx.transportsRepo.deactivate(transportId);
          else ctx.transportsRepo.reactivate(transportId);
          sendJson(res, 200, { ok: true });
        } catch (err) {
          sendRepoError(res, err);
        }
        return;
      }

      const transportTestMatch = req.method === 'POST' && pathname.match(/^\/transports\/([^/]+)\/test$/);
      if (transportTestMatch) {
        const transport = ctx.transportsRepo.getById(transportTestMatch[1]);
        if (!transport) {
          sendJson(res, 404, { error: `Transport ${transportTestMatch[1]} not found.` });
          return;
        }
        try {
          const body = await readJsonBody(req).catch(() => ({}));
          const result = await testTransportConnection(ctx, transport, Boolean((body as { trustHost?: boolean }).trustHost));
          sendJson(res, result.ok ? 200 : 502, result);
        } catch (err) {
          sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      const transportIdMatch = req.method === 'PATCH' && pathname.match(/^\/transports\/([^/]+)$/);
      if (transportIdMatch) {
        try {
          const { passphrase, password, ...rest } = await readJsonBody(req);
          const patch: Record<string, unknown> = { ...rest };
          if (passphrase) patch.passphraseSecretRef = resolvePassphraseSecretRef(ctx, passphrase);
          if (password) patch.passwordSecretRef = resolveFtpPasswordSecretRef(ctx, password);
          if (patch.privateKeyPath) patch.privateKeyPath = await copyPrivateKeyIntoAppStorage(patch.privateKeyPath as string);
          const transport = ctx.transportsRepo.update(transportIdMatch[1], patch);
          sendJson(res, 200, transport);
        } catch (err) {
          sendRepoError(res, err);
        }
        return;
      }

      if (req.method === 'POST' && pathname === '/database-connections') {
        try {
          const body = await readJsonBody(req);
          if (!body.clientId || !body.name || !body.engine || !body.host || !body.port || !body.databaseName || !body.username) {
            sendJson(res, 400, { error: 'clientId, name, engine, host, port, databaseName, and username are required.' });
            return;
          }
          const connection = ctx.databaseConnectionsRepo.create({
            clientId: body.clientId,
            name: body.name,
            engine: body.engine,
            host: body.host,
            port: body.port,
            databaseName: body.databaseName,
            username: body.username,
            passwordSecretRef: resolveSecretRef(ctx, body.password, 'databaseConnection:password'),
            sslMode: body.sslMode ?? null,
          });
          sendJson(res, 201, connection);
        } catch (err) {
          sendRepoError(res, err);
        }
        return;
      }

      const dbConnSetActiveMatch = req.method === 'POST' && pathname.match(/^\/database-connections\/([^/]+)\/(deactivate|reactivate)$/);
      if (dbConnSetActiveMatch) {
        try {
          const [, connectionId, action] = dbConnSetActiveMatch;
          if (action === 'deactivate') ctx.databaseConnectionsRepo.deactivate(connectionId);
          else ctx.databaseConnectionsRepo.reactivate(connectionId);
          sendJson(res, 200, { ok: true });
        } catch (err) {
          sendRepoError(res, err);
        }
        return;
      }

      const dbConnTestMatch = req.method === 'POST' && pathname.match(/^\/database-connections\/([^/]+)\/test$/);
      if (dbConnTestMatch) {
        const connection = ctx.databaseConnectionsRepo.getById(dbConnTestMatch[1]);
        if (!connection) {
          sendJson(res, 404, { error: `Database connection ${dbConnTestMatch[1]} not found.` });
          return;
        }
        try {
          const result = await testDatabaseConnection(connection, ctx.secretStore);
          sendJson(res, result.ok ? 200 : 502, result);
        } catch (err) {
          sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      const dbConnIdMatch = req.method === 'PATCH' && pathname.match(/^\/database-connections\/([^/]+)$/);
      if (dbConnIdMatch) {
        try {
          const { password, ...rest } = await readJsonBody(req);
          const patch: Record<string, unknown> = { ...rest };
          if (password) patch.passwordSecretRef = resolveSecretRef(ctx, password, 'databaseConnection:password');
          const connection = ctx.databaseConnectionsRepo.update(dbConnIdMatch[1], patch);
          sendJson(res, 200, connection);
        } catch (err) {
          sendRepoError(res, err);
        }
        return;
      }

      if (req.method === 'GET' && pathname === '/tasks') {
        const includeInactive = url.searchParams.get('includeInactive') === 'true';
        const clients = ctx.clientsRepo.listActive();
        const tasks = clients.flatMap((client) =>
          ctx.tasksRepo
            .listByClient(client.id)
            .filter((t) => includeInactive || t.isActive)
            .map((t) => {
              const transport = t.transportId ? ctx.transportsRepo.getById(t.transportId) : null;
              const databaseConnection = t.databaseConnectionId ? ctx.databaseConnectionsRepo.getById(t.databaseConnectionId) : null;
              // Lets a caller (the UI) disable/relabel "Ejecutar ahora" while a
              // run is genuinely in progress, without needing its own polling
              // loop — the engine's own app-level lock in runBackupTask.ts is
              // still what actually prevents a double-run; this is purely a
              // UX nicety on top of that already-safe guarantee.
              const latestRun = ctx.runsRepo.getLatestByTask(t.id);
              const backupSet = t.backupSetId ? ctx.backupSetsRepo.getById(t.backupSetId) : null;
              // Whether the task's remote-* pipeline fields are still editable
              // (see UpdateTaskInput's doc comment) — a real backup locks them.
              const hasRealBackups = ctx.runsRepo.listBackups({ taskId: t.id, limit: 1 }).total > 0;
              const owner = t.transportId
                ? ctx.vaultCredentialsRepo.getByLinkedTransportId(t.transportId)
                : t.databaseConnectionId
                  ? ctx.vaultCredentialsRepo.getByLinkedDatabaseConnectionId(t.databaseConnectionId)
                  : null;
              return {
                ...t,
                kind: 'db' as const,
                clientName: client.name,
                transportName: transport?.name ?? null,
                databaseConnectionName: databaseConnection?.name ?? null,
                latestRunStatus: latestRun?.status ?? null,
                backupSetName: backupSet?.name ?? null,
                hasRealBackups,
                credentialName: owner?.name ?? null,
                operationalSyncState: owner?.operationalSyncState ?? null,
              };
            })
        );
        sendJson(res, 200, tasks);
        return;
      }

      if (req.method === 'GET' && pathname === '/runs') {
        const taskId = url.searchParams.get('taskId') ?? undefined;
        const clientId = url.searchParams.get('clientId') ?? undefined;
        const limitParam = url.searchParams.get('limit');
        const runs = ctx.runsRepo.listRecent({ taskId, clientId, limit: limitParam ? Number(limitParam) : undefined }).map((run) => {
          const client = ctx.clientsRepo.getById(run.clientId);
          const task = ctx.tasksRepo.getById(run.taskId);
          const backupSet = task?.backupSetId ? ctx.backupSetsRepo.getById(task.backupSetId) : null;
          // A run's local_path column is never cleared when its file is deleted
          // (manually, or by automated retention — see "Retention" in
          // CLAUDE.md) — this tells the UI whether the download/delete actions
          // are still meaningful for this row, without hiding the row itself
          // (Historial's whole point is showing every attempt, deleted or not).
          const localFileExists = Boolean(run.localPath && existsSync(run.localPath));
          return { ...run, kind: 'db' as const, clientName: client?.name ?? null, taskName: task?.name ?? null, backupSetName: backupSet?.name ?? null, localFileExists };
        });
        sendJson(res, 200, runs);
        return;
      }

      if (req.method === 'GET' && pathname === '/backups') {
        const clientId = url.searchParams.get('clientId') ?? undefined;
        const taskId = url.searchParams.get('taskId') ?? undefined;
        const limitParam = url.searchParams.get('limit');
        const offsetParam = url.searchParams.get('offset');
        const { runs, total } = ctx.runsRepo.listBackups({
          clientId,
          taskId,
          limit: limitParam ? Number(limitParam) : undefined,
          offset: offsetParam ? Number(offsetParam) : undefined,
        });
        // listBackups' "real backups only" contract means a deleted backup
        // (manual or automated-retention) shouldn't appear here at all —
        // the DB row's status/local_path alone can't tell (retention/manual
        // delete never clear local_path), so this is the same existsSync
        // check the download route already relies on, applied per row.
        // Note: filtering after the SQL LIMIT/OFFSET means `total` (and a
        // page's row count) can be a small overcount right after a
        // deletion — an accepted, minor tradeoff over adding real
        // "deleted" state to the schema just for exact pagination.
        const enriched = runs
          .filter((run) => run.localPath && existsSync(run.localPath))
          .map((run) => {
            const client = ctx.clientsRepo.getById(run.clientId);
            const task = ctx.tasksRepo.getById(run.taskId);
            const backupSet = task?.backupSetId ? ctx.backupSetsRepo.getById(task.backupSetId) : null;
            return { ...run, clientName: client?.name ?? null, taskName: task?.name ?? null, backupSetName: backupSet?.name ?? null };
          });
        sendJson(res, 200, { runs: enriched, total });
        return;
      }

      const runDownloadMatch = req.method === 'GET' && pathname.match(/^\/runs\/([^/]+)\/download$/);
      if (runDownloadMatch) {
        const run = ctx.runsRepo.getById(runDownloadMatch[1]);
        // localPath can point at a file retention already deleted (retention never clears the DB column, only the file
        // on disk — see the "Retention" section in CLAUDE.md) — existsSync is the real check, not just "is the column set".
        if (!run || !run.localPath || !existsSync(run.localPath)) {
          sendJson(res, 404, { error: 'No hay un archivo de backup disponible para esta ejecución.' });
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${basename(run.localPath)}"`,
        });
        createReadStream(run.localPath).pipe(res);
        return;
      }

      const runDeleteMatch = req.method === 'POST' && pathname.match(/^\/runs\/([^/]+)\/delete$/);
      if (runDeleteMatch) {
        try {
          const result = await deleteBackupRun(runDeleteMatch[1], { runsRepo: ctx.runsRepo, retentionDeletionsRepo: ctx.retentionDeletionsRepo });
          sendJson(res, 200, result);
        } catch (err) {
          sendRepoError(res, err);
        }
        return;
      }

      if (req.method === 'GET' && pathname === '/logs') {
        const limitParam = url.searchParams.get('limit');
        const offsetParam = url.searchParams.get('offset');
        const { events, total } = ctx.logEventsRepo.listRecent({
          search: url.searchParams.get('search') ?? undefined,
          step: url.searchParams.get('step') ?? undefined,
          level: (url.searchParams.get('level') as any) ?? undefined,
          from: url.searchParams.get('from') ?? undefined,
          to: url.searchParams.get('to') ?? undefined,
          clientId: url.searchParams.get('client') ?? undefined,
          limit: limitParam ? Number(limitParam) : undefined,
          offset: offsetParam ? Number(offsetParam) : undefined,
        });
        // A page of log lines often repeats the same run_id many times (every step of one run) — cache the client/task lookup per run instead of re-querying per line.
        const runNameCache = new Map<string, { clientId: string | null; clientName: string | null; taskName: string | null }>();
        function resolveRunNames(runId: string | null) {
          if (!runId) return { clientId: null, clientName: null, taskName: null };
          const cached = runNameCache.get(runId);
          if (cached) return cached;
          const run = ctx.runsRepo.getById(runId);
          const client = run ? ctx.clientsRepo.getById(run.clientId) : null;
          const task = run ? ctx.tasksRepo.getById(run.taskId) : null;
          const names = { clientId: client?.id ?? null, clientName: client?.name ?? null, taskName: task?.name ?? null };
          runNameCache.set(runId, names);
          return names;
        }
        const enrichedEvents = events.map((event) => ({ ...event, ...resolveRunNames(event.runId) }));
        sendJson(res, 200, { events: enrichedEvents, total, steps: ctx.logEventsRepo.listDistinctSteps() });
        return;
      }

      // Mirrors /logs exactly (same response shape: { events, total, steps })
      // but backed by file_backup_log_events / file_backup_runs / file_backup_tasks
      // -- its own domain, see fileBackupLogEventsRepo.ts for why this isn't
      // just /logs with a filter.
      if (req.method === 'GET' && pathname === '/file-logs') {
        const limitParam = url.searchParams.get('limit');
        const offsetParam = url.searchParams.get('offset');
        const { events, total } = ctx.fileBackupLogEventsRepo.listRecent({
          search: url.searchParams.get('search') ?? undefined,
          step: url.searchParams.get('step') ?? undefined,
          level: (url.searchParams.get('level') as any) ?? undefined,
          from: url.searchParams.get('from') ?? undefined,
          to: url.searchParams.get('to') ?? undefined,
          clientId: url.searchParams.get('client') ?? undefined,
          limit: limitParam ? Number(limitParam) : undefined,
          offset: offsetParam ? Number(offsetParam) : undefined,
        });
        const fileRunNameCache = new Map<string, { clientId: string | null; clientName: string | null; taskName: string | null }>();
        function resolveFileRunNames(runId: string | null) {
          if (!runId) return { clientId: null, clientName: null, taskName: null };
          const cached = fileRunNameCache.get(runId);
          if (cached) return cached;
          const run = ctx.fileBackupRunsRepo.getById(runId);
          const client = run ? ctx.clientsRepo.getById(run.clientId) : null;
          const task = run ? ctx.fileBackupTasksRepo.getById(run.taskId) : null;
          const names = { clientId: client?.id ?? null, clientName: client?.name ?? null, taskName: task?.name ?? null };
          fileRunNameCache.set(runId, names);
          return names;
        }
        const enrichedFileEvents = events.map((event) => ({ ...event, ...resolveFileRunNames(event.runId) }));
        sendJson(res, 200, { events: enrichedFileEvents, total, steps: ctx.fileBackupLogEventsRepo.listDistinctSteps() });
        return;
      }

      if (req.method === 'GET' && pathname === '/system') {
        sendJson(res, 200, getSystemInfo());
        return;
      }

      if (req.method === 'GET' && pathname === '/scheduler-status') {
        const heartbeatAt = ctx.settingsRepo.get(SCHEDULER_HEARTBEAT_KEY);
        const heartbeatAgeSeconds = heartbeatAt ? Math.max(0, Math.round((Date.now() - Date.parse(heartbeatAt)) / 1000)) : null;
        sendJson(res, 200, { heartbeatAt, heartbeatAgeSeconds });
        return;
      }

      // --- Encrypted credential vault (Tier 2) lifecycle ---------------------
      if (req.method === 'GET' && pathname === '/vault/status') {
        sendJson(res, 200, getVaultStatus(ctx.vaultState));
        return;
      }

      if (req.method === 'POST' && pathname === '/vault/lock') {
        ctx.vaultState.lock();
        sendJson(res, 200, getVaultStatus(ctx.vaultState));
        return;
      }

      // Explicit "unlock with Windows" — recover the DEK via this machine's
      // DPAPI-CurrentUser-sealed KEK, no master password. Works even after a
      // manual lock (that only blocks the *automatic* startup path).
      if (req.method === 'POST' && pathname === '/vault/unlock-with-windows') {
        try {
          ctx.vaultState.unlockWithWindows();
          sendJson(res, 200, getVaultStatus(ctx.vaultState));
          if (ctx.vaultState.isUnlocked()) {
            void runDueVaultBackups(buildVaultBackupDeps(ctx)).catch((err) =>
              console.error(`Vault backup catch-up failed: ${err instanceof Error ? err.message : String(err)}`)
            );
            void runPocketPublish(buildPocketPublishDeps(ctx)).catch((err) =>
              console.error(`Pocket publish catch-up failed: ${err instanceof Error ? err.message : String(err)}`)
            );
          }
        } catch (err) {
          if (err instanceof VaultAutoUnlockUnavailableError) {
            sendJson(res, 409, { error: err.message });
          } else if (err instanceof VaultNotInitializedError) {
            sendJson(res, 409, { error: err.message });
          } else {
            sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
          }
        }
        return;
      }

      // Enable/disable the per-machine auto-unlock material.
      if (req.method === 'POST' && (pathname === '/vault/auto-unlock/enable' || pathname === '/vault/auto-unlock/disable')) {
        try {
          if (pathname === '/vault/auto-unlock/enable') {
            const body = await readJsonBody(req).catch(() => ({}));
            if (typeof body.password !== 'string' || body.password.length < 1) {
              sendJson(res, 400, { error: 'password is required to enable auto-unlock.' });
              return;
            }
            ctx.vaultState.enableAutoUnlock(body.password);
          } else {
            ctx.vaultState.disableAutoUnlock();
          }
          sendJson(res, 200, getVaultStatus(ctx.vaultState));
        } catch (err) {
          if (err instanceof WrongMasterPasswordError) {
            sendJson(res, 401, { error: err.message });
          } else if (err instanceof VaultAutoUnlockUnavailableError || err instanceof VaultNotInitializedError) {
            sendJson(res, 409, { error: err.message });
          } else {
            sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
          }
        }
        return;
      }

      if (
        req.method === 'POST' &&
        (pathname === '/vault/init' || pathname === '/vault/unlock' || pathname === '/vault/change-password')
      ) {
        const body = await readJsonBody(req).catch(() => ({}));
        try {
          if (pathname === '/vault/init') {
            if (typeof body.password !== 'string' || body.password.length < 1) {
              sendJson(res, 400, { error: 'password is required.' });
              return;
            }
            ctx.vaultState.init(body.password);
          } else if (pathname === '/vault/unlock') {
            if (typeof body.password !== 'string' || body.password.length < 1) {
              sendJson(res, 400, { error: 'password is required.' });
              return;
            }
            // `enableAutoUnlock` is best-effort inside unlock(): a sealing
            // failure never fails the unlock. The client re-reads status.
            ctx.vaultState.unlock(body.password, { enableAutoUnlock: body.enableAutoUnlock === true });
          } else {
            if (
              typeof body.currentPassword !== 'string' ||
              typeof body.newPassword !== 'string' ||
              body.newPassword.length < 1
            ) {
              sendJson(res, 400, { error: 'currentPassword and newPassword are required.' });
              return;
            }
            ctx.vaultState.changePassword(body.currentPassword, body.newPassword);
          }
          sendJson(res, 200, getVaultStatus(ctx.vaultState));
          if (ctx.vaultState.isUnlocked()) {
            if (pathname === '/vault/change-password') {
              // Old .arkvault files still need the OLD password — force a fresh
              // one now so recovery isn't stuck on a password the user replaced.
              void runAllVaultBackups(buildVaultBackupDeps(ctx)).catch((err) =>
                console.error(`Vault backup after password change failed: ${err instanceof Error ? err.message : String(err)}`)
              );
            } else {
              // Unlock / first init: catch up any destination with no recent-enough backup.
              void runDueVaultBackups(buildVaultBackupDeps(ctx)).catch((err) =>
                console.error(`Vault backup catch-up failed: ${err instanceof Error ? err.message : String(err)}`)
              );
              // Same for Pocket: a change made while the vault was locked (or
              // a change right before Arkode was closed, before the debounce
              // fired) must not stay stuck — see docs/pocket.md's "catch-up"
              // behavior. runPocketPublish() itself no-ops if not configured/dirty.
              void runPocketPublish(buildPocketPublishDeps(ctx)).catch((err) =>
                console.error(`Pocket publish catch-up failed: ${err instanceof Error ? err.message : String(err)}`)
              );
            }
          }
        } catch (err) {
          if (err instanceof WrongMasterPasswordError) {
            sendJson(res, 401, { error: err.message });
          } else if (err instanceof VaultAlreadyInitializedError || err instanceof VaultNotInitializedError) {
            sendJson(res, 409, { error: err.message });
          } else {
            sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
          }
        }
        return;
      }

      // --- Vault settings (auto-lock) ------------------------------------
      if (pathname === '/vault/settings') {
        if (req.method === 'GET') {
          const raw = Number.parseInt(ctx.settingsRepo.get('vaultAutoLockMinutes') ?? '', 10);
          sendJson(res, 200, { autoLockMinutes: Number.isFinite(raw) && raw > 0 ? raw : 15 });
          return;
        }
        if (req.method === 'PATCH') {
          try {
            const body = await readJsonBody(req);
            const n = Number(body.autoLockMinutes);
            if (!Number.isFinite(n) || n < 0 || n > 1440) {
              sendJson(res, 400, { error: 'autoLockMinutes must be 0–1440 (0 = never).' });
              return;
            }
            ctx.settingsRepo.set('vaultAutoLockMinutes', String(Math.round(n)));
            ctx.vaultState.setAutoLockMs(n > 0 ? Math.round(n) * 60_000 : null);
            sendJson(res, 200, { autoLockMinutes: Math.round(n) });
          } catch (err) {
            sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
          }
          return;
        }
      }

      // --- Vault credentials (Tier 2) --------------------------------------
      // GET is metadata-only and works while locked; reveal / write need unlock.
      const clientCredsMatch = req.method === 'GET' && pathname.match(/^\/clients\/([^/]+)\/credentials$/);
      if (clientCredsMatch) {
        sendJson(res, 200, ctx.vaultCredentialsRepo.listByClient(clientCredsMatch[1]));
        return;
      }

      if (req.method === 'GET' && pathname === '/vault/search') {
        const tokens = (url.searchParams.get('q') ?? '').split(/\s+/).filter((t) => t.length > 0);
        const clientId = url.searchParams.get('client') ?? undefined;
        sendJson(res, 200, {
          credentials: ctx.vaultCredentialsRepo.search(tokens, clientId),
          urls: ctx.vaultUrlsRepo.search(tokens, clientId),
          items: ctx.vaultItemsRepo.search(tokens, clientId),
        });
        return;
      }

      const clientUrlsMatch = req.method === 'GET' && pathname.match(/^\/clients\/([^/]+)\/urls$/);
      if (clientUrlsMatch) {
        sendJson(res, 200, ctx.vaultUrlsRepo.listByClient(clientUrlsMatch[1]));
        return;
      }
      const clientItemsMatch = req.method === 'GET' && pathname.match(/^\/clients\/([^/]+)\/items$/);
      if (clientItemsMatch) {
        const type = url.searchParams.get('type') as 'snippet' | 'process' | 'note' | null;
        sendJson(res, 200, ctx.vaultItemsRepo.listByClient(clientItemsMatch[1], type ?? undefined));
        return;
      }
      const clientWorkspaceMatch = req.method === 'GET' && pathname.match(/^\/clients\/([^/]+)\/workspace$/);
      if (clientWorkspaceMatch) {
        const cid = clientWorkspaceMatch[1];
        sendJson(res, 200, {
          credentials: ctx.vaultCredentialsRepo.listByClient(cid),
          urls: ctx.vaultUrlsRepo.listByClient(cid),
          items: ctx.vaultItemsRepo.listByClient(cid),
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/vault/urls') {
        try {
          const body = await readJsonBody(req);
          if (!body.clientId || !body.name || !body.url) {
            sendJson(res, 400, { error: 'clientId, name, and url are required.' });
            return;
          }
          sendJson(res, 201, ctx.vaultUrlsRepo.create({
            clientId: body.clientId,
            name: body.name,
            url: body.url,
            environment: body.environment ?? null,
            tags: Array.isArray(body.tags) ? body.tags : [],
            linkedCredentialId: body.linkedCredentialId ?? null,
            favorite: Boolean(body.favorite),
            description: body.description ?? null,
          }));
        } catch (err) {
          sendRepoError(res, err);
        }
        return;
      }
      const urlByIdMatch = pathname.match(/^\/vault\/urls\/([^/]+)$/);
      if (urlByIdMatch && (req.method === 'PATCH' || req.method === 'DELETE')) {
        try {
          if (req.method === 'DELETE') {
            ctx.vaultUrlsRepo.delete(urlByIdMatch[1]);
            sendJson(res, 200, { ok: true });
            return;
          }
          sendJson(res, 200, ctx.vaultUrlsRepo.update(urlByIdMatch[1], await readJsonBody(req)));
        } catch (err) {
          sendRepoError(res, err);
        }
        return;
      }

      if (req.method === 'POST' && pathname === '/vault/items') {
        try {
          const body = await readJsonBody(req);
          if (!body.clientId || !body.type || !body.title) {
            sendJson(res, 400, { error: 'clientId, type, and title are required.' });
            return;
          }
          const isSensitive = Boolean(body.isSensitive);
          const bodyText: string | null = body.body ?? null;
          let bodyBlobRef: string | null = null;
          let bodyPlaintext: string | null = null;
          if (isSensitive && bodyText) {
            if (!ctx.vaultState.isUnlocked()) {
              sendJson(res, 423, { error: 'The vault is locked. Unlock it to store a sensitive body.' });
              return;
            }
            bodyBlobRef = `vault:item:${randomUUID()}`;
            ctx.vaultSecretStore.set(bodyBlobRef, bodyText);
          } else {
            bodyPlaintext = bodyText;
          }
          sendJson(res, 201, ctx.vaultItemsRepo.create({
            clientId: body.clientId,
            type: body.type,
            title: body.title,
            environment: body.environment ?? null,
            tags: Array.isArray(body.tags) ? body.tags : [],
            description: body.description ?? null,
            favorite: Boolean(body.favorite),
            isSensitive,
            bodyPlaintext,
            bodyBlobRef,
            metadata: body.metadata ?? {},
          }));
        } catch (err) {
          sendRepoError(res, err);
        }
        return;
      }
      const itemByIdMatch = pathname.match(/^\/vault\/items\/([^/]+)$/);
      if (itemByIdMatch && (req.method === 'PATCH' || req.method === 'DELETE')) {
        const id = itemByIdMatch[1];
        const existing = ctx.vaultItemsRepo.getById(id);
        if (!existing) {
          sendJson(res, 404, { error: `Vault item ${id} not found.` });
          return;
        }
        try {
          if (req.method === 'DELETE') {
            const { bodyBlobRef } = ctx.vaultItemsRepo.delete(id);
            if (bodyBlobRef) ctx.vaultSecretStore.delete(bodyBlobRef);
            sendJson(res, 200, { ok: true });
            return;
          }
          const body = await readJsonBody(req);
          const { body: bodyText, ...rest } = body;
          const patch = { ...rest } as Record<string, unknown>;
          if ('body' in body) {
            const isSensitive = 'isSensitive' in body ? Boolean(body.isSensitive) : existing.isSensitive;
            if (isSensitive) {
              if (!ctx.vaultState.isUnlocked()) {
                sendJson(res, 423, { error: 'The vault is locked. Unlock it to change a sensitive body.' });
                return;
              }
              const ref = existing.bodyBlobRef ?? `vault:item:${randomUUID()}`;
              ctx.vaultSecretStore.set(ref, bodyText ?? '');
              patch.bodyBlobRef = ref;
              patch.bodyPlaintext = null;
            } else {
              if (existing.bodyBlobRef) ctx.vaultSecretStore.delete(existing.bodyBlobRef);
              patch.bodyPlaintext = bodyText ?? null;
              patch.bodyBlobRef = null;
            }
          }
          sendJson(res, 200, ctx.vaultItemsRepo.update(id, patch));
        } catch (err) {
          sendRepoError(res, err);
        }
        return;
      }
      const itemRevealMatch = req.method === 'POST' && pathname.match(/^\/vault\/items\/([^/]+)\/reveal$/);
      if (itemRevealMatch) {
        const item = ctx.vaultItemsRepo.getById(itemRevealMatch[1]);
        if (!item) {
          sendJson(res, 404, { error: 'Vault item not found.' });
          return;
        }
        if (item.isSensitive && !ctx.vaultState.isUnlocked()) {
          sendJson(res, 423, { error: 'The vault is locked.' });
          return;
        }
        try {
          const body = item.isSensitive
            ? item.bodyBlobRef
              ? ctx.vaultSecretStore.get(item.bodyBlobRef)
              : ''
            : item.bodyPlaintext;
          sendJson(res, 200, { body: body ?? '' });
        } catch (err) {
          if (err instanceof VaultLockedError) sendJson(res, 423, { error: err.message });
          else if (err instanceof VaultCryptoError)
            sendJson(res, 500, { error: `This item's body is corrupted: ${err.message}` });
          else sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      if (req.method === 'POST' && pathname === '/vault/credentials') {
        try {
          const body = await readJsonBody(req);
          if (!body.clientId || !body.name || !body.kind) {
            sendJson(res, 400, { error: 'clientId, name, and kind are required.' });
            return;
          }
          const secret = normalizeCredentialSecret(body.secret);
          if (secret && !ctx.vaultState.isUnlocked()) {
            sendJson(res, 423, { error: 'The vault is locked. Unlock it to store a secret.' });
            return;
          }
          let secretBlobRef: string | null = null;
          if (secret) {
            secretBlobRef = newCredentialSecretRef();
            writeCredentialSecret(ctx.vaultSecretStore, secretBlobRef, secret);
          }
          const created = ctx.vaultCredentialsRepo.create({
            clientId: body.clientId,
            name: body.name,
            kind: body.kind,
            environment: body.environment ?? null,
            tags: Array.isArray(body.tags) ? body.tags : [],
            host: body.host ?? null,
            port: body.port ?? null,
            username: body.username ?? null,
            databaseName: body.databaseName ?? null,
            url: body.url ?? null,
            secretBlobRef,
            favorite: Boolean(body.favorite),
            description: body.description ?? null,
          });
          let operationalSync: { ok: boolean; state: string; message?: string } = { ok: true, state: 'none' };
          if (body.useForBackups) {
            operationalSync = syncOperationalCopy(buildVaultSyncDeps(ctx), created.id, {
              useForBackups: true,
              secret: secret ?? {},
            });
          }
          sendJson(res, 201, { credential: ctx.vaultCredentialsRepo.getById(created.id), operationalSync });
        } catch (err) {
          sendRepoError(res, err);
        }
        return;
      }

      const credByIdMatch = pathname.match(/^\/vault\/credentials\/([^/]+)$/);
      if (credByIdMatch && (req.method === 'PATCH' || req.method === 'DELETE')) {
        const id = credByIdMatch[1];
        const existing = ctx.vaultCredentialsRepo.getById(id);
        if (!existing) {
          sendJson(res, 404, { error: `Vault credential ${id} not found.` });
          return;
        }
        try {
          if (req.method === 'DELETE') {
            const { secretBlobRef } = ctx.vaultCredentialsRepo.delete(id);
            if (secretBlobRef) ctx.vaultSecretStore.delete(secretBlobRef);
            sendJson(res, 200, { ok: true });
            return;
          }
          const body = await readJsonBody(req);
          const hasSecretField = 'secret' in body;
          const secret = hasSecretField ? normalizeCredentialSecret(body.secret) : undefined;
          if (hasSecretField && !ctx.vaultState.isUnlocked()) {
            sendJson(res, 423, { error: 'The vault is locked. Unlock it to change a secret.' });
            return;
          }
          const { secret: _s, useForBackups: _u, ...metaPatch } = body;
          const updated = ctx.vaultCredentialsRepo.update(id, metaPatch);

          const wantsBridge = body.useForBackups === true;
          if (secret && !wantsBridge) {
            const ref = existing.secretBlobRef ?? newCredentialSecretRef();
            writeCredentialSecret(ctx.vaultSecretStore, ref, secret);
            if (!existing.secretBlobRef) ctx.vaultCredentialsRepo.setSecretBlobRef(id, ref);
          } else if (hasSecretField && secret === undefined && existing.secretBlobRef && !wantsBridge) {
            // `secret: null/{}` explicitly clears it.
            ctx.vaultSecretStore.delete(existing.secretBlobRef);
            ctx.vaultCredentialsRepo.setSecretBlobRef(id, null);
          }

          let operationalSync: { ok: boolean; state: string; message?: string } = {
            ok: true,
            state: updated.operationalSyncState,
          };
          if (body.useForBackups === true) {
            // syncOperationalCopy owns the blob write (atomic with the Tier-1 copy) when a secret is supplied.
            const currentRef = ctx.vaultCredentialsRepo.getById(id)!.secretBlobRef ?? newCredentialSecretRef();
            if (!ctx.vaultCredentialsRepo.getById(id)!.secretBlobRef) {
              ctx.vaultCredentialsRepo.setSecretBlobRef(id, currentRef);
            }
            operationalSync = syncOperationalCopy(buildVaultSyncDeps(ctx), id, {
              useForBackups: true,
              ...(secret ? { secret } : {}),
            });
          } else if (body.useForBackups === false) {
            operationalSync = syncOperationalCopy(buildVaultSyncDeps(ctx), id, { useForBackups: false });
          }

          sendJson(res, 200, {
            credential: ctx.vaultCredentialsRepo.getById(id),
            operationalSync,
          });
        } catch (err) {
          sendRepoError(res, err);
        }
        return;
      }

      const credRevealMatch = req.method === 'POST' && pathname.match(/^\/vault\/credentials\/([^/]+)\/reveal$/);
      if (credRevealMatch) {
        const id = credRevealMatch[1];
        const cred = ctx.vaultCredentialsRepo.getById(id);
        if (!cred) {
          sendJson(res, 404, { error: `Vault credential ${id} not found.` });
          return;
        }
        if (!ctx.vaultState.isUnlocked()) {
          sendJson(res, 423, { error: 'The vault is locked.' });
          return;
        }
        try {
          const secret = cred.secretBlobRef ? readCredentialSecret(ctx.vaultSecretStore, cred.secretBlobRef) : {};
          sendJson(res, 200, { secret });
        } catch (err) {
          if (err instanceof VaultLockedError) {
            sendJson(res, 423, { error: err.message });
          } else if (err instanceof VaultCryptoError) {
            sendJson(res, 500, { error: `This credential's secret is corrupted and cannot be decrypted: ${err.message}` });
          } else {
            sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
          }
        }
        return;
      }

      const credResyncMatch = req.method === 'POST' && pathname.match(/^\/vault\/credentials\/([^/]+)\/resync-operational$/);
      if (credResyncMatch) {
        const id = credResyncMatch[1];
        if (!ctx.vaultCredentialsRepo.getById(id)) {
          sendJson(res, 404, { error: `Vault credential ${id} not found.` });
          return;
        }
        if (!ctx.vaultState.isUnlocked()) {
          sendJson(res, 423, { error: 'The vault is locked.' });
          return;
        }
        try {
          const result = syncOperationalCopy(buildVaultSyncDeps(ctx), id, { useForBackups: true });
          sendJson(res, result.ok ? 200 : 502, result);
        } catch (err) {
          if (err instanceof VaultLockedError) sendJson(res, 423, { error: err.message });
          else sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      if (req.method === 'POST' && pathname === '/vault/resync-operational') {
        if (!ctx.vaultState.isUnlocked()) {
          sendJson(res, 423, { error: 'The vault is locked.' });
          return;
        }
        const body = await readJsonBody(req).catch(() => ({}));
        try {
          const results = resyncOperationalCopies(buildVaultSyncDeps(ctx), body.client ?? undefined);
          const allOk = results.every((r) => r.result.ok);
          sendJson(res, allOk ? 200 : 502, { results, allOk });
        } catch (err) {
          if (err instanceof VaultLockedError) sendJson(res, 423, { error: err.message });
          else sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      // --- Portable vault backup (.arkvault) ------------------------------
      if (req.method === 'GET' && pathname === '/vault/backup-targets') {
        sendJson(
          res,
          200,
          ctx.vaultBackupTargetsRepo.list().map((t) => ({
            ...t,
            // google_drive: whether an OAuth token is actually stored (mirrors replication_targets.authorized).
            authorized: t.kind === 'google_drive' ? !!t.rcloneConfigSecretRef && !!ctx.secretStore.get(t.rcloneConfigSecretRef) : undefined,
          }))
        );
        return;
      }
      if (req.method === 'POST' && pathname === '/vault/backup-targets') {
        try {
          const body = await readJsonBody(req);
          if (body.kind === 'google_drive') {
            if (!body.remotePath) {
              sendJson(res, 400, { error: 'remotePath is required for a Google Drive destination.' });
              return;
            }
            sendJson(res, 201, ctx.vaultBackupTargetsRepo.createGoogleDrive({
              remotePath: String(body.remotePath).trim(),
              label: body.label ?? null,
              retentionCount: body.retentionCount ?? null,
              enabled: body.enabled !== false,
            }));
            return;
          }
          if (!body.path) {
            sendJson(res, 400, { error: 'path is required.' });
            return;
          }
          sendJson(res, 201, ctx.vaultBackupTargetsRepo.create({
            path: body.path,
            retentionCount: body.retentionCount ?? null,
            enabled: body.enabled !== false,
          }));
        } catch (err) {
          sendRepoError(res, err);
        }
        return;
      }

      const vbtAuthorizeMatch = req.method === 'POST' && pathname.match(/^\/vault\/backup-targets\/([^/]+)\/authorize$/);
      if (vbtAuthorizeMatch) {
        try {
          const target = ctx.vaultBackupTargetsRepo.getById(vbtAuthorizeMatch[1]);
          if (!target || target.kind !== 'google_drive' || !target.rcloneConfigSecretRef) {
            sendJson(res, 400, { error: 'Not a Google Drive vault-backup destination.' });
            return;
          }
          const body = await readJsonBody(req);
          if (body.reuseFromReplicationTargetId) {
            const src = ctx.replicationTargetsRepo.getById(String(body.reuseFromReplicationTargetId));
            const raw = src?.rcloneConfigSecretRef ? ctx.secretStore.get(src.rcloneConfigSecretRef) : null;
            if (!raw) {
              sendJson(res, 400, { error: 'That replication target has no connected Google account to reuse.' });
              return;
            }
            JSON.parse(raw); // validate
            ctx.secretStore.set(target.rcloneConfigSecretRef, raw);
            sendJson(res, 200, { ok: true });
            return;
          }
          const token = rcloneClient.extractTokenBlob(String(body.token ?? '')) ?? String(body.token ?? '').trim();
          JSON.parse(token); // validate
          const config: RcloneDriveConfig = { token };
          if (body.clientId && body.clientSecret) {
            config.clientId = String(body.clientId);
            config.clientSecret = String(body.clientSecret);
          }
          ctx.secretStore.set(target.rcloneConfigSecretRef, JSON.stringify(config));
          sendJson(res, 200, { ok: true });
        } catch (err) {
          sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      const vbtTestMatch = req.method === 'POST' && pathname.match(/^\/vault\/backup-targets\/([^/]+)\/test$/);
      if (vbtTestMatch) {
        const target = ctx.vaultBackupTargetsRepo.getById(vbtTestMatch[1]);
        if (!target || target.kind !== 'google_drive' || !target.rcloneConfigSecretRef) {
          sendJson(res, 400, { error: 'Not a Google Drive vault-backup destination.' });
          return;
        }
        const raw = ctx.secretStore.get(target.rcloneConfigSecretRef);
        if (!raw) {
          sendJson(res, 502, { ok: false, error: 'Google Drive is not connected for this destination.' });
          return;
        }
        try {
          const drive = JSON.parse(raw) as RcloneDriveConfig;
          const detail = await rcloneClient.withRcloneConfig(
            { encryptWithCrypt: false },
            { provider: 'rclone_drive', drive },
            undefined,
            (configPath, remoteSection) => rcloneClient.rcloneAbout({ configPath, remoteSection })
          );
          sendJson(res, 200, { ok: true, detail });
        } catch (err) {
          sendJson(res, 502, { ok: false, error: redactSecrets(err instanceof Error ? err.message : String(err)) });
        }
        return;
      }

      const vbtByIdMatch = pathname.match(/^\/vault\/backup-targets\/([^/]+)$/);
      if (vbtByIdMatch && req.method === 'PATCH') {
        try {
          sendJson(res, 200, ctx.vaultBackupTargetsRepo.update(vbtByIdMatch[1], await readJsonBody(req)));
        } catch (err) {
          sendRepoError(res, err);
        }
        return;
      }
      const vbtRemoveMatch = req.method === 'POST' && pathname.match(/^\/vault\/backup-targets\/([^/]+)\/remove$/);
      if (vbtRemoveMatch) {
        ctx.vaultBackupTargetsRepo.remove(vbtRemoveMatch[1]);
        sendJson(res, 200, { ok: true });
        return;
      }
      if (req.method === 'GET' && pathname === '/vault/backup-runs') {
        const limit = url.searchParams.get('limit');
        sendJson(res, 200, ctx.vaultBackupTargetsRepo.listRecentRuns(limit ? Number(limit) : undefined));
        return;
      }
      if (req.method === 'POST' && pathname === '/vault/backup') {
        if (!ctx.vaultState.isUnlocked()) {
          sendJson(res, 423, { error: 'The vault is locked.' });
          return;
        }
        try {
          const result = await runAllVaultBackups(buildVaultBackupDeps(ctx));
          sendJson(res, result.allOk ? 200 : 502, result);
        } catch (err) {
          sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }
      if (req.method === 'POST' && pathname === '/vault/restore') {
        const body = await readJsonBody(req).catch(() => ({}));
        if (typeof body.fileBase64 !== 'string' || typeof body.password !== 'string') {
          sendJson(res, 400, { error: 'fileBase64 and password are required.' });
          return;
        }
        try {
          const buf = Buffer.from(body.fileBase64, 'base64');
          const result = importVaultBuffer(buildVaultBackupDeps(ctx), buf, body.password);
          sendJson(res, 200, result);
        } catch (err) {
          if (err instanceof WrongMasterPasswordError) sendJson(res, 401, { error: err.message });
          else if (err instanceof ArkvaultParseError) sendJson(res, 400, { error: err.message });
          else if (err instanceof Error && /already has a vault/i.test(err.message)) sendJson(res, 409, { error: err.message });
          else sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      // --- Arkode Pocket (read-only mobile credential viewer) -------------
      // See docs/pocket.md. Deliberately its own tiny surface: status,
      // configure, Drive account (own connection, reusable from an existing
      // one), pairing (QR payload), manual publish, and revoke. No device
      // list/management beyond the single v1 device.
      if (req.method === 'GET' && pathname === '/pocket/status') {
        sendJson(res, 200, pocketStatusJson(ctx));
        return;
      }

      if (req.method === 'POST' && pathname === '/pocket/configure') {
        try {
          const body = await readJsonBody(req);
          if (!body.driveRemotePath || typeof body.driveRemotePath !== 'string') {
            sendJson(res, 400, { error: 'driveRemotePath is required.' });
            return;
          }
          configurePocket({ pocketStateRepo: ctx.pocketStateRepo, secretStore: ctx.secretStore }, { driveRemotePath: body.driveRemotePath.trim() });
          // A first-time configure is always "dirty" (nothing published yet)
          // — try right away rather than waiting for the debounce sweep,
          // which deliberately never fires for a state that has never been
          // published (see runPocketPublishQuietly's dirtySince guard). A
          // no-op if Drive isn't connected yet (fails into last_error, same
          // as any other publish attempt) — the user still sees a clear
          // "Google Drive is not connected" status rather than nothing.
          void runPocketPublish(buildPocketPublishDeps(ctx)).catch(() => {});
          sendJson(res, 200, pocketStatusJson(ctx));
        } catch (err) {
          sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      if (req.method === 'POST' && (pathname === '/pocket/enable' || pathname === '/pocket/disable')) {
        try {
          setPocketEnabled({ pocketStateRepo: ctx.pocketStateRepo, secretStore: ctx.secretStore }, pathname === '/pocket/enable');
          sendJson(res, 200, pocketStatusJson(ctx));
        } catch (err) {
          sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      if (req.method === 'POST' && pathname === '/pocket/drive/connect') {
        try {
          const body = await readJsonBody(req).catch(() => ({}));
          if (body.reuse) {
            // body.reuse = { source: 'vault-backup' | 'replication', id: string }
            let sourceRef: string | null = null;
            if (body.reuse.source === 'vault-backup') {
              sourceRef = vaultBackupTargetConfigRef(String(body.reuse.id));
            } else if (body.reuse.source === 'replication') {
              const src = ctx.replicationTargetsRepo.getById(String(body.reuse.id));
              sourceRef = src?.rcloneConfigSecretRef ?? null;
            }
            if (!sourceRef) {
              sendJson(res, 400, { error: 'Unknown or unsupported account to reuse.' });
              return;
            }
            reusePocketDriveTokenFrom(ctx.secretStore, sourceRef);
            sendJson(res, 200, pocketStatusJson(ctx));
            return;
          }
          const token = rcloneClient.extractTokenBlob(String(body.token ?? '')) ?? String(body.token ?? '').trim();
          JSON.parse(token); // validate the INNER oauth blob itself, not just the outer wrapper — same as vault-backup-target's own authorize route
          setPocketDriveToken(ctx.secretStore, JSON.stringify({ token } satisfies RcloneDriveConfig));
          sendJson(res, 200, pocketStatusJson(ctx));
        } catch (err) {
          sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      if (req.method === 'POST' && pathname === '/pocket/drive/disconnect') {
        disconnectPocketDrive(ctx.secretStore);
        sendJson(res, 200, pocketStatusJson(ctx));
        return;
      }

      if (req.method === 'POST' && pathname === '/pocket/drive/test') {
        const drive = getPocketDriveConfig(ctx.secretStore);
        if (!drive) {
          sendJson(res, 502, { ok: false, error: 'Google Drive is not connected for Arkode Pocket.' });
          return;
        }
        try {
          const detail = await rcloneClient.withRcloneConfig(
            { encryptWithCrypt: false },
            { provider: 'rclone_drive', drive },
            undefined,
            (configPath, remoteSection) => rcloneClient.rcloneAbout({ configPath, remoteSection })
          );
          sendJson(res, 200, { ok: true, detail });
        } catch (err) {
          sendJson(res, 502, { ok: false, error: redactSecrets(err instanceof Error ? err.message : String(err)) });
        }
        return;
      }

      if (req.method === 'POST' && pathname === '/pocket/pairing') {
        try {
          const body = await readJsonBody(req).catch(() => ({}));
          // A pairing QR bakes in the CURRENT Pocket DEK. Right after a
          // revoke, `dirty` is forced true precisely because the DEK just
          // rotated and the file on Drive is still encrypted under the OLD
          // one — generating a QR in that window hands out a key that
          // doesn't match anything actually downloadable yet, which a
          // device pairing in that gap experiences as a raw decrypt/parse
          // failure, not a clear "try again" message. Publishing first
          // (whenever dirty) closes that window structurally instead of
          // just wording the error better after the fact.
          if (ctx.pocketStateRepo.get()?.dirty) {
            const publishResult = await runPocketPublish(buildPocketPublishDeps(ctx));
            if (publishResult.status === 'failed') {
              sendJson(res, 409, {
                error:
                  `No se pudo publicar el estado actual antes de generar el código de vinculación (${publishResult.error ?? 'error desconocido'}). ` +
                  'Solucioná eso primero — un código generado ahora podría no coincidir con el archivo publicado en Drive.',
              });
              return;
            }
          }
          const payload = generatePocketPairingPayload(
            { pocketStateRepo: ctx.pocketStateRepo, secretStore: ctx.secretStore },
            typeof body.deviceLabel === 'string' ? body.deviceLabel : undefined
          );
          sendJson(res, 200, { payload, status: pocketStatusJson(ctx) });
        } catch (err) {
          sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      if (req.method === 'POST' && pathname === '/pocket/revoke') {
        try {
          await revokePocketDevice({ pocketStateRepo: ctx.pocketStateRepo, secretStore: ctx.secretStore });
          // A revoked key should be reflected in the next .arkvault backup soon
          // (see docs/pocket.md) — nudge the same "due" sweep vault backups
          // already use, best-effort, never blocking the response.
          void runDueVaultBackups(buildVaultBackupDeps(ctx)).catch(() => {});
          sendJson(res, 200, pocketStatusJson(ctx));
        } catch (err) {
          sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      if (req.method === 'POST' && pathname === '/pocket/publish') {
        try {
          const body = await readJsonBody(req).catch(() => ({}));
          const result = await runPocketPublish(buildPocketPublishDeps(ctx), { force: body.force === true });
          // `result.status` is the publish outcome ('published'/'failed'/...);
          // `pocketStatus` is the full current state snapshot — kept as two
          // distinct fields since both are genuinely named "status" in their
          // own domain and must not clobber each other.
          sendJson(res, result.status === 'published' || result.status === 'skipped_not_dirty' ? 200 : 502, {
            ...result,
            pocketStatus: pocketStatusJson(ctx),
          });
        } catch (err) {
          sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      if (req.method === 'GET' && pathname === '/tool-registry') {
        sendJson(res, 200, {
          postgres: createPostgresToolRegistry(ctx.settingsRepo).list(),
          mysql: createMysqlToolRegistry(ctx.settingsRepo).list(),
          mariadb: createMariaDbToolRegistry(ctx.settingsRepo).list(),
        });
        return;
      }

      if (req.method === 'GET' && pathname === '/tool-registry/detect') {
        sendJson(res, 200, { tools: await detectInstalledDbTools() });
        return;
      }

      const toolRegistryActionMatch = req.method === 'POST' && pathname.match(/^\/tool-registry\/(postgres|mysql|mariadb)\/(register|unregister)$/);
      if (toolRegistryActionMatch) {
        try {
          const [, engine, action] = toolRegistryActionMatch;
          const body = await readJsonBody(req);
          if (!body.version) {
            sendJson(res, 400, { error: 'version is required.' });
            return;
          }

          if (action === 'unregister') {
            if (engine === 'postgres') createPostgresToolRegistry(ctx.settingsRepo).unregister(body.version);
            else if (engine === 'mysql') createMysqlToolRegistry(ctx.settingsRepo).unregister(body.version);
            else createMariaDbToolRegistry(ctx.settingsRepo).unregister(body.version);
            sendJson(res, 200, { ok: true });
            return;
          }

          if (engine === 'postgres') {
            if (!body.pgDumpPath || !body.pgRestorePath) {
              sendJson(res, 400, { error: 'pgDumpPath and pgRestorePath are required for postgres.' });
              return;
            }
            createPostgresToolRegistry(ctx.settingsRepo).register(body.version, {
              pgDumpPath: body.pgDumpPath,
              pgRestorePath: body.pgRestorePath,
            });
          } else if (engine === 'mysql') {
            if (!body.mysqldumpPath) {
              sendJson(res, 400, { error: 'mysqldumpPath is required for mysql.' });
              return;
            }
            createMysqlToolRegistry(ctx.settingsRepo).register(body.version, { mysqldumpPath: body.mysqldumpPath });
          } else {
            if (!body.mariaDbDumpPath) {
              sendJson(res, 400, { error: 'mariaDbDumpPath is required for mariadb.' });
              return;
            }
            createMariaDbToolRegistry(ctx.settingsRepo).register(body.version, { mariaDbDumpPath: body.mariaDbDumpPath });
          }
          sendJson(res, 200, { ok: true });
        } catch (err) {
          sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      const toolRegistryDownloadMatch = req.method === 'POST' && pathname.match(/^\/tool-registry\/(postgres|mariadb)\/download$/);
      if (toolRegistryDownloadMatch) {
        try {
          const [, engine] = toolRegistryDownloadMatch as [string, 'postgres' | 'mariadb'];
          const body = await readJsonBody(req);
          if (!body.version || !body.exactVersion) {
            sendJson(res, 400, { error: 'version (registry key, e.g. "18") and exactVersion (e.g. "18.6-1") are both required.' });
            return;
          }
          const destDir = vendoredToolsDir(engine, body.version);
          const paths = await downloadTool({ engine, exactVersion: body.exactVersion, destDir });
          if (engine === 'postgres') {
            createPostgresToolRegistry(ctx.settingsRepo).register(body.version, paths as { pgDumpPath: string; pgRestorePath: string });
          } else {
            createMariaDbToolRegistry(ctx.settingsRepo).register(body.version, paths as { mariaDbDumpPath: string });
          }
          sendJson(res, 200, { ok: true, paths });
        } catch (err) {
          sendJson(res, 502, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      if (req.method === 'GET' && pathname === '/config/export') {
        try {
          const clientIds = url.searchParams.getAll('clientId');
          const data = exportConfig(clientIds.length > 0 ? clientIds : 'all', ctx);
          const filename =
            data.clients.length === 1
              ? `arkode-config-export-${data.clients[0].name.replace(/[^a-z0-9-_]+/gi, '_')}.json`
              : 'arkode-config-export.json';
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Content-Disposition': `attachment; filename="${filename}"`,
          });
          res.end(JSON.stringify(data, null, 2));
        } catch (err) {
          sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      if (req.method === 'POST' && pathname === '/config/import') {
        try {
          const body = await readJsonBody(req);
          if (body.schemaVersion !== 1) {
            sendJson(res, 400, { error: `Unsupported config export schemaVersion: ${body.schemaVersion}` });
            return;
          }
          const result = importConfig(body as ConfigExport, ctx);
          sendJson(res, 200, result);
        } catch (err) {
          sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      const taskExportMatch = req.method === 'GET' && pathname.match(/^\/tasks\/([^/]+)\/export$/);
      if (taskExportMatch) {
        try {
          const bundle = exportTask(taskExportMatch[1], ctx);
          const filename = `arkode-task-export-${bundle.task.name.replace(/[^a-z0-9-_]+/gi, '_')}.json`;
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Content-Disposition': `attachment; filename="${filename}"`,
          });
          res.end(JSON.stringify(bundle, null, 2));
        } catch (err) {
          sendJson(res, err instanceof Error && /not found/i.test(err.message) ? 404 : 500, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }

      if (req.method === 'POST' && pathname === '/tasks/import') {
        try {
          const body = await readJsonBody(req);
          if (!body.clientId) {
            sendJson(res, 400, { error: 'clientId is required.' });
            return;
          }
          if (body.bundle?.schemaVersion !== 1) {
            sendJson(res, 400, { error: `Unsupported task export schemaVersion: ${body.bundle?.schemaVersion}` });
            return;
          }
          const result = importTaskBundle(body.bundle as ExportedTaskBundle, body.clientId, ctx);
          sendJson(res, result.errors.length > 0 && !result.taskId ? 400 : 200, result);
        } catch (err) {
          sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      if (req.method === 'POST' && pathname === '/tasks') {
        try {
          const body = await readJsonBody(req);
          if (!body.clientId || !body.name || !body.strategy) {
            sendJson(res, 400, { error: 'clientId, name, and strategy are required.' });
            return;
          }
          const dbEngine = body.dbEngine ?? 'unknown';
          const retentionCount = body.retentionCount ?? null;
          const retentionDays = body.retentionDays ?? null;
          const backupSetId = body.backupSetId ?? null;

          let task;
          if (body.strategy === 'direct_dump') {
            if (!body.databaseConnectionId) {
              sendJson(res, 400, { error: 'databaseConnectionId is required for direct_dump.' });
              return;
            }
            task = ctx.tasksRepo.createDirectDump({
              clientId: body.clientId,
              databaseConnectionId: body.databaseConnectionId,
              name: body.name,
              dbEngine,
              retentionCount,
              retentionDays,
              backupSetId,
            });
          } else {
            if (!body.transportId) {
              sendJson(res, 400, { error: `${body.strategy} tasks require transportId.` });
              return;
            }
            const base = { clientId: body.clientId, transportId: body.transportId, name: body.name, dbEngine, retentionCount, retentionDays, backupSetId };
            if (body.strategy === 'remote_dump') {
              if (!body.remoteOutputPathTemplate) {
                sendJson(res, 400, { error: 'remoteOutputPathTemplate is required for remote_dump.' });
                return;
              }
              const dockerMode = body.remoteDumpExecMode === 'docker';
              if (!dockerMode && !body.remoteCommand) {
                sendJson(res, 400, { error: 'remoteCommand is required for remote_dump tasks with remoteDumpExecMode "host".' });
                return;
              }
              if (dockerMode && (!body.dockerContainer || !body.remoteDumpDatabase || !body.remoteDumpDbUser)) {
                sendJson(res, 400, { error: 'dockerContainer, remoteDumpDatabase, and remoteDumpDbUser are required for remote_dump tasks with remoteDumpExecMode "docker".' });
                return;
              }
              task = ctx.tasksRepo.createRemoteDump({
                ...base,
                remoteCommand: dockerMode ? undefined : body.remoteCommand,
                remoteOutputPathTemplate: body.remoteOutputPathTemplate,
                remoteCleanup: Boolean(body.remoteCleanup),
                remoteDumpExecMode: dockerMode ? 'docker' : 'host',
                dockerContainer: dockerMode ? body.dockerContainer : undefined,
                remoteDumpDatabase: dockerMode ? body.remoteDumpDatabase : undefined,
                remoteDumpDbUser: dockerMode ? body.remoteDumpDbUser : undefined,
                remoteDumpDbPasswordSecretRef: dockerMode ? resolveSecretRef(ctx, body.remoteDumpDbPassword, 'task:remoteDumpDbPassword') : undefined,
              });
            } else {
              if (!body.remotePath) {
                sendJson(res, 400, { error: 'remotePath is required for fetch_existing.' });
                return;
              }
              task = ctx.tasksRepo.createFetchExisting({ ...base, remotePath: body.remotePath, remoteFilePattern: body.remoteFilePattern ?? null });
            }
          }

          let scheduleBlocked: DirectDumpCompatibilityResult | null = null;
          if (body.scheduleTime) {
            const scheduleEnabled = body.scheduleEnabled !== false;
            scheduleBlocked = scheduleEnabled ? await checkScheduleCompatibilityGate(ctx, task, Boolean(body.force)) : null;
            if (!scheduleBlocked) {
              task = ctx.tasksRepo.setSchedule(task.id, {
                scheduleTime: body.scheduleTime,
                scheduleEnabled,
                scheduleFrequency: body.scheduleFrequency,
                scheduleDaysOfWeek: body.scheduleDaysOfWeek,
                scheduleDayOfMonth: body.scheduleDayOfMonth,
              });
            }
          }

          // scheduleBlocked (only possible for direct_dump) means the task was created but its
          // requested schedule wasn't applied — still a 201, since task creation itself succeeded.
          sendJson(res, 201, scheduleBlocked ? { ...task, scheduleBlocked } : task);
        } catch (err) {
          sendRepoError(res, err);
        }
        return;
      }

      const taskSetActiveMatch = req.method === 'POST' && pathname.match(/^\/tasks\/([^/]+)\/(deactivate|reactivate)$/);
      if (taskSetActiveMatch) {
        try {
          const [, taskId, action] = taskSetActiveMatch;
          if (action === 'deactivate') ctx.tasksRepo.deactivate(taskId);
          else ctx.tasksRepo.reactivate(taskId);
          sendJson(res, 200, { ok: true });
        } catch (err) {
          sendRepoError(res, err);
        }
        return;
      }

      const taskScheduleMatch = req.method === 'POST' && pathname.match(/^\/tasks\/([^/]+)\/schedule$/);
      if (taskScheduleMatch) {
        try {
          const body = await readJsonBody(req);
          const taskId = taskScheduleMatch[1];
          const scheduleEnabled = Boolean(body.scheduleEnabled);
          if (scheduleEnabled) {
            const existingTask = ctx.tasksRepo.getById(taskId);
            if (!existingTask) {
              sendJson(res, 404, { error: `Task ${taskId} not found.` });
              return;
            }
            const gateFailure = await checkScheduleCompatibilityGate(ctx, existingTask, Boolean(body.force));
            if (gateFailure) {
              sendJson(res, 409, { error: 'compatibility_failed', compatibility: gateFailure });
              return;
            }
          }
          const task = ctx.tasksRepo.setSchedule(taskId, {
            scheduleTime: body.scheduleTime ?? null,
            scheduleEnabled,
            scheduleFrequency: body.scheduleFrequency,
            scheduleDaysOfWeek: body.scheduleDaysOfWeek,
            scheduleDayOfMonth: body.scheduleDayOfMonth,
          });
          sendJson(res, 200, task);
        } catch (err) {
          sendRepoError(res, err);
        }
        return;
      }

      const taskIdMatch = req.method === 'PATCH' && pathname.match(/^\/tasks\/([^/]+)$/);
      if (taskIdMatch) {
        try {
          const body = await readJsonBody(req);
          const task = ctx.tasksRepo.update(taskIdMatch[1], body);
          sendJson(res, 200, task);
        } catch (err) {
          sendRepoError(res, err);
        }
        return;
      }

      // === File backups (restic-backed) ===

      if (req.method === 'GET' && pathname === '/file-repos') {
        const clientId = url.searchParams.get('client');
        const repos = clientId
          ? [ctx.fileBackupRepositoriesRepo.getByClientId(clientId)].filter((r) => r != null)
          : ctx.fileBackupRepositoriesRepo.listForActiveClients();
        sendJson(res, 200, repos);
        return;
      }

      if (req.method === 'POST' && pathname === '/file-repos') {
        try {
          const body = await readJsonBody(req);
          if (!body.clientId) {
            sendJson(res, 400, { error: 'clientId is required.' });
            return;
          }
          const { repository, recoveryKey } = await createFileBackupRepository(body.clientId, {
            clientsRepo: ctx.clientsRepo,
            fileBackupRepositoriesRepo: ctx.fileBackupRepositoriesRepo,
            secretStore: ctx.secretStore,
          });
          sendJson(res, 201, { ...repository, recoveryKey });
        } catch (err) {
          sendRepoError(res, err);
        }
        return;
      }

      const exportKeyMatch = req.method === 'GET' && pathname.match(/^\/file-repos\/([^/]+)\/export-key$/);
      if (exportKeyMatch) {
        try {
          const recoveryKey = exportFileBackupRepositoryKey(exportKeyMatch[1], ctx);
          sendJson(res, 200, { recoveryKey });
        } catch (err) {
          sendRepoError(res, err);
        }
        return;
      }

      // Deduplicated on-disk footprint of the repo + its real snapshot count
      // (authoritative, from restic — not a DB row count, since retention
      // forgets snapshots but leaves the run rows).
      const repoSizeMatch = req.method === 'GET' && pathname.match(/^\/file-repos\/([^/]+)\/size$/);
      if (repoSizeMatch) {
        try {
          const repo = ctx.fileBackupRepositoriesRepo.getById(repoSizeMatch[1]);
          if (!repo) {
            sendJson(res, 404, { error: `File-backup repository ${repoSizeMatch[1]} not found.` });
            return;
          }
          const password = ctx.secretStore.get(repo.passwordSecretRef);
          const [diskBytes, snapshots] = await Promise.all([
            resticClient.directorySizeBytes(repo.repoPath),
            password ? resticClient.listSnapshots(repo.repoPath, password) : Promise.resolve([]),
          ]);
          sendJson(res, 200, { diskBytes, snapshotCount: snapshots.length });
        } catch (err) {
          sendRepoError(res, err);
        }
        return;
      }

      const maintenanceMatch = req.method === 'POST' && pathname.match(/^\/file-repos\/([^/]+)\/run-maintenance$/);
      if (maintenanceMatch) {
        try {
          const body = await readJsonBody(req);
          const outcomes = await runFileBackupMaintenance(
            { fileBackupRepositoriesRepo: ctx.fileBackupRepositoriesRepo, fileBackupMaintenanceRunsRepo: ctx.fileBackupMaintenanceRunsRepo, fileBackupRunsRepo: ctx.fileBackupRunsRepo, secretStore: ctx.secretStore },
            { repositoryId: maintenanceMatch[1], operation: mapMaintenanceOperationFlag(body.operation) }
          );
          sendJson(res, 200, outcomes);
        } catch (err) {
          sendRepoError(res, err);
        }
        return;
      }

      if (req.method === 'GET' && pathname === '/file-tasks') {
        const clientId = url.searchParams.get('client');
        const includeInactive = url.searchParams.get('includeInactive') === 'true';
        // With ?client= -> that client's file tasks (as before). Without it ->
        // every active client's file tasks, for the unified Tareas view.
        const scoped: { clientId: string; clientName: string }[] = clientId
          ? (() => {
              const c = ctx.clientsRepo.getById(clientId);
              return c ? [{ clientId: c.id, clientName: c.name }] : [{ clientId, clientName: '' }];
            })()
          : ctx.clientsRepo.listActive().map((c) => ({ clientId: c.id, clientName: c.name }));
        const enriched = scoped.flatMap(({ clientId: cid, clientName }) =>
          ctx.fileBackupTasksRepo
            .listByClient(cid)
            .filter((t) => includeInactive || t.isActive)
            .map((t) => {
              const transport = t.transportId ? ctx.transportsRepo.getById(t.transportId) : null;
              const latestRun = ctx.fileBackupRunsRepo.getLatestByTask(t.id);
              return {
                ...t,
                kind: 'file' as const,
                hasSnapshots: ctx.fileBackupRunsRepo.getLatestSuccessfulByTask(t.id) != null,
                clientName,
                transportName: transport?.name ?? null,
                latestRunStatus: latestRun?.status ?? null,
                backupSetName: t.backupSetId ? (ctx.backupSetsRepo.getById(t.backupSetId)?.name ?? null) : null,
              };
            })
        );
        sendJson(res, 200, enriched);
        return;
      }

      if (req.method === 'POST' && pathname === '/file-tasks') {
        try {
          const body = await readJsonBody(req);
          if (!body.clientId || !body.name) {
            sendJson(res, 400, { error: 'clientId and name are required.' });
            return;
          }
          const repository = ctx.fileBackupRepositoriesRepo.getByClientId(body.clientId);
          if (!repository) {
            sendJson(res, 400, { error: 'This client has no file-backup repository yet — create one first (POST /file-repos).' });
            return;
          }
          let task;
          if (body.sourceKind === 'remote_folder') {
            if (!body.transportId || !body.remoteSourcePath) {
              sendJson(res, 400, { error: 'remote_folder tasks require transportId and remoteSourcePath.' });
              return;
            }
            task = ctx.fileBackupTasksRepo.createRemoteFolder({
              clientId: body.clientId,
              repositoryId: repository.id,
              name: body.name,
              transportId: body.transportId,
              remoteSourcePath: body.remoteSourcePath,
              retentionCount: body.retentionCount ?? null,
              retentionDays: body.retentionDays ?? null,
              backupSetId: body.backupSetId ?? null,
            });
          } else {
            if (!body.sourcePath) {
              sendJson(res, 400, { error: 'local_folder tasks require sourcePath.' });
              return;
            }
            task = ctx.fileBackupTasksRepo.createLocalFolder({
              clientId: body.clientId,
              repositoryId: repository.id,
              name: body.name,
              sourcePath: resolvePath(body.sourcePath),
              retentionCount: body.retentionCount ?? null,
              retentionDays: body.retentionDays ?? null,
              backupSetId: body.backupSetId ?? null,
            });
          }
          if (body.scheduleTime) {
            ctx.fileBackupTasksRepo.setSchedule(task.id, {
              scheduleTime: body.scheduleTime,
              scheduleEnabled: body.scheduleEnabled ?? true,
              scheduleFrequency: body.scheduleFrequency,
              scheduleDaysOfWeek: body.scheduleDaysOfWeek,
              scheduleDayOfMonth: body.scheduleDayOfMonth,
            });
          }
          const created = ctx.fileBackupTasksRepo.getById(task.id);
          sendJson(res, 201, created);
        } catch (err) {
          sendRepoError(res, err);
        }
        return;
      }

      const fileTaskIdMatch = req.method === 'PATCH' && pathname.match(/^\/file-tasks\/([^/]+)$/);
      if (fileTaskIdMatch) {
        try {
          const body = await readJsonBody(req);
          const task = ctx.fileBackupTasksRepo.update(fileTaskIdMatch[1], body);
          sendJson(res, 200, task);
        } catch (err) {
          sendRepoError(res, err);
        }
        return;
      }

      const fileTaskActionMatch = req.method === 'POST' && pathname.match(/^\/file-tasks\/([^/]+)\/(deactivate|reactivate|run|test-connection)$/);
      if (fileTaskActionMatch) {
        const [, taskId, action] = fileTaskActionMatch;
        try {
          if (action === 'deactivate') {
            ctx.fileBackupTasksRepo.deactivate(taskId);
            sendJson(res, 200, { ok: true });
          } else if (action === 'reactivate') {
            ctx.fileBackupTasksRepo.reactivate(taskId);
            sendJson(res, 200, { ok: true });
          } else if (action === 'test-connection') {
            const task = ctx.fileBackupTasksRepo.getById(taskId);
            if (!task) {
              sendJson(res, 404, { error: `File-backup task ${taskId} not found.` });
              return;
            }
            if (task.sourceKind !== 'remote_folder' || !task.transportId) {
              sendJson(res, 400, { error: `Task ${taskId} is a ${task.sourceKind} task — test-connection only applies to remote_folder.` });
              return;
            }
            const transport = ctx.transportsRepo.getById(task.transportId);
            if (!transport) {
              sendJson(res, 404, { error: `Transport ${task.transportId} not found.` });
              return;
            }
            const body = await readJsonBody(req);
            const result = await testTransportConnection(ctx, transport, body.trustHost === true);
            sendJson(res, result.ok ? 200 : 502, result);
          } else {
            const task = ctx.fileBackupTasksRepo.getById(taskId);
            if (!task) {
              sendJson(res, 404, { error: `File-backup task ${taskId} not found.` });
              return;
            }
            const result = await runFileBackupTaskNow(ctx, task);
            sendJson(res, 200, result.run);
          }
        } catch (err) {
          sendRepoError(res, err);
        }
        return;
      }

      const fileTaskScheduleMatch = req.method === 'POST' && pathname.match(/^\/file-tasks\/([^/]+)\/schedule$/);
      if (fileTaskScheduleMatch) {
        try {
          const body = await readJsonBody(req);
          const task = ctx.fileBackupTasksRepo.setSchedule(fileTaskScheduleMatch[1], {
            scheduleTime: body.disable ? (ctx.fileBackupTasksRepo.getById(fileTaskScheduleMatch[1])?.scheduleTime ?? null) : body.scheduleTime,
            scheduleEnabled: !body.disable,
            scheduleFrequency: body.scheduleFrequency,
            scheduleDaysOfWeek: body.scheduleDaysOfWeek,
            scheduleDayOfMonth: body.scheduleDayOfMonth,
          });
          sendJson(res, 200, task);
        } catch (err) {
          sendRepoError(res, err);
        }
        return;
      }

      if (req.method === 'GET' && pathname === '/file-runs') {
        const limitParam = url.searchParams.get('limit');
        const runs = ctx.fileBackupRunsRepo.listRecent({
          taskId: url.searchParams.get('task') ?? undefined,
          clientId: url.searchParams.get('client') ?? undefined,
          limit: limitParam ? Number(limitParam) : undefined,
        });
        const clientNameCache = new Map<string, string | null>();
        const taskNameCache = new Map<string, string | null>();
        const enriched = runs.map((run) => {
          if (!clientNameCache.has(run.clientId)) {
            clientNameCache.set(run.clientId, ctx.clientsRepo.getById(run.clientId)?.name ?? null);
          }
          if (!taskNameCache.has(run.taskId)) {
            taskNameCache.set(run.taskId, ctx.fileBackupTasksRepo.getById(run.taskId)?.name ?? null);
          }
          return {
            ...run,
            kind: 'file' as const,
            clientName: clientNameCache.get(run.clientId) ?? null,
            taskName: taskNameCache.get(run.taskId) ?? null,
          };
        });
        sendJson(res, 200, enriched);
        return;
      }

      const fileRunRestoreMatch = req.method === 'POST' && pathname.match(/^\/file-runs\/([^/]+)\/restore$/);
      if (fileRunRestoreMatch) {
        try {
          const body = await readJsonBody(req);
          if (!body.targetDir) {
            sendJson(res, 400, { error: 'targetDir is required.' });
            return;
          }
          const target = resolvePath(body.targetDir);
          await mkdir(target, { recursive: true });
          const result = await restoreFileBackupRun(fileRunRestoreMatch[1], target, {
            fileBackupRunsRepo: ctx.fileBackupRunsRepo,
            fileBackupRepositoriesRepo: ctx.fileBackupRepositoriesRepo,
            secretStore: ctx.secretStore,
          });
          sendJson(res, 200, { ...result, targetDir: target });
        } catch (err) {
          sendRepoError(res, err);
        }
        return;
      }

      const fileRunDeleteMatch = req.method === 'POST' && pathname.match(/^\/file-runs\/([^/]+)\/delete$/);
      if (fileRunDeleteMatch) {
        try {
          const result = await deleteFileBackupRun(fileRunDeleteMatch[1], {
            fileBackupRunsRepo: ctx.fileBackupRunsRepo,
            fileBackupRepositoriesRepo: ctx.fileBackupRepositoriesRepo,
            fileBackupRetentionDeletionsRepo: ctx.fileBackupRetentionDeletionsRepo,
            fileBackupMaintenanceRunsRepo: ctx.fileBackupMaintenanceRunsRepo,
            secretStore: ctx.secretStore,
          });
          sendJson(res, 200, result);
        } catch (err) {
          sendRepoError(res, err);
        }
        return;
      }

      const fileRunDownloadFileMatch = req.method === 'GET' && pathname.match(/^\/file-runs\/([^/]+)\/download-file$/);
      if (fileRunDownloadFileMatch) {
        const sourcePath = url.searchParams.get('path');
        if (!sourcePath) {
          sendJson(res, 400, { error: 'A ?path= query param (the file\'s original absolute path) is required.' });
          return;
        }
        const tempDest = joinPath(tmpdir(), `arkode-file-download-${randomUUID()}${basename(sourcePath) ? '-' + basename(sourcePath) : ''}`);
        try {
          await restoreFileBackupFile(fileRunDownloadFileMatch[1], sourcePath, tempDest, {
            fileBackupRunsRepo: ctx.fileBackupRunsRepo,
            fileBackupRepositoriesRepo: ctx.fileBackupRepositoriesRepo,
            secretStore: ctx.secretStore,
          });
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': `attachment; filename="${basename(sourcePath)}"`,
          });
          const stream = createReadStream(tempDest);
          stream.pipe(res);
          stream.on('close', () => {
            unlink(tempDest).catch(() => {});
          });
        } catch (err) {
          sendRepoError(res, err);
          await unlink(tempDest).catch(() => {});
        }
        return;
      }

      // === Off-site replication to Google Drive (rclone) ===
      if (req.method === 'GET' && pathname === '/replication-targets') {
        const clientFilter = url.searchParams.get('client');
        const targets = clientFilter
          ? ctx.replicationTargetsRepo.listByClient(clientFilter)
          : ctx.replicationTargetsRepo.listEnabled();
        const repDeps = buildReplicationDeps(ctx);
        sendJson(
          res,
          200,
          targets.map((t) => ({
            ...t,
            clientName: ctx.clientsRepo.getById(t.clientId)?.name ?? null,
            transportName: t.transportId ? (ctx.transportsRepo.getById(t.transportId)?.name ?? null) : null,
            authorized: t.provider === 'rclone_drive' ? Boolean(t.rcloneConfigSecretRef && ctx.secretStore.get(t.rcloneConfigSecretRef)) : Boolean(t.transportId),
            due: isReplicationDue(t, repDeps),
          }))
        );
        return;
      }

      if (req.method === 'POST' && pathname === '/replication-targets') {
        try {
          const body = await readJsonBody(req);
          const content = parseReplicationContent(String(body.content));
          const provider = parseReplicationProvider(typeof body.provider === 'string' ? body.provider : undefined);
          if (!ctx.clientsRepo.getById(body.clientId)) {
            sendJson(res, 400, { error: `Client ${body.clientId} not found.` });
            return;
          }
          const encrypt = content === 'db_dumps' && body.encrypt !== false;
          let cryptRef: string | null = null;
          let generated: string | null = null;
          if (encrypt) {
            cryptRef = replicationCryptSecretRef(body.clientId, content);
            const pw =
              typeof body.cryptPassword === 'string' && body.cryptPassword
                ? body.cryptPassword
                : randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
            ctx.secretStore.set(cryptRef, pw);
            if (!body.cryptPassword) generated = pw;
          }

          let transportId: string | undefined;
          let rcloneConfigSecretRef: string | undefined;
          if (provider === 'rclone_drive') {
            rcloneConfigSecretRef = replicationConfigSecretRef(body.clientId, content);
          } else {
            const transport = typeof body.transportId === 'string' ? ctx.transportsRepo.getById(body.transportId) : null;
            if (!transport || transport.clientId !== body.clientId) {
              sendJson(res, 400, { error: `Transport ${body.transportId} not found for client ${body.clientId}.` });
              return;
            }
            const expectedType = provider === 'rclone_sftp' ? 'sftp' : 'ftp';
            if (transport.type !== expectedType) {
              sendJson(res, 400, { error: `--provider ${expectedType} needs a "${expectedType}" transport, got "${transport.type}".` });
              return;
            }
            transportId = transport.id;
          }

          const target = ctx.replicationTargetsRepo.create({
            clientId: body.clientId,
            content,
            provider,
            remotePath: String(body.remotePath ?? '').trim(),
            rcloneConfigSecretRef,
            transportId,
            encryptWithCrypt: encrypt,
            cryptPasswordSecretRef: cryptRef,
          });
          sendJson(res, 201, { ...target, generatedCryptPassword: generated });
        } catch (err) {
          sendRepoError(res, err);
        }
        return;
      }

      const replAuthorizeMatch = req.method === 'POST' && pathname.match(/^\/replication-targets\/([^/]+)\/authorize$/);
      if (replAuthorizeMatch) {
        try {
          const target = ctx.replicationTargetsRepo.getById(replAuthorizeMatch[1]);
          if (!target) {
            sendJson(res, 404, { error: 'not found' });
            return;
          }
          if (target.provider !== 'rclone_drive') {
            sendJson(res, 400, { error: 'Esta replicación no usa Google Drive; no requiere autorización.' });
            return;
          }
          const body = await readJsonBody(req);
          const token = rcloneClient.extractTokenBlob(String(body.token ?? '')) ?? String(body.token ?? '').trim();
          JSON.parse(token); // validate
          const config: RcloneDriveConfig = { token };
          if (body.clientId && body.clientSecret) {
            config.clientId = String(body.clientId);
            config.clientSecret = String(body.clientSecret);
          }
          ctx.secretStore.set(target.rcloneConfigSecretRef!, JSON.stringify(config));
          sendJson(res, 200, { ok: true });
        } catch (err) {
          sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      const replCryptMatch = req.method === 'GET' && pathname.match(/^\/replication-targets\/([^/]+)\/crypt-password$/);
      if (replCryptMatch) {
        const target = ctx.replicationTargetsRepo.getById(replCryptMatch[1]);
        if (!target) {
          sendJson(res, 404, { error: 'not found' });
          return;
        }
        const pw = target.cryptPasswordSecretRef ? ctx.secretStore.get(target.cryptPasswordSecretRef) : null;
        sendJson(res, 200, { cryptPassword: pw ?? null });
        return;
      }

      const replTestMatch = req.method === 'POST' && pathname.match(/^\/replication-targets\/([^/]+)\/test$/);
      if (replTestMatch) {
        try {
          const target = ctx.replicationTargetsRepo.getById(replTestMatch[1]);
          if (!target) {
            sendJson(res, 404, { error: 'not found' });
            return;
          }
          const remote = await resolveRcloneRemote(ctx, target);
          const cryptPassword = loadReplicationCryptPassword(ctx, target);
          const out = await rcloneClient.withRcloneConfig(target, remote, cryptPassword, (configPath, remoteSection) =>
            rcloneClient.rcloneAbout({ configPath, remoteSection })
          );
          sendJson(res, 200, { ok: true, detail: out });
        } catch (err) {
          sendJson(res, 502, { ok: false, error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      const replRunMatch = req.method === 'POST' && pathname.match(/^\/replication-targets\/([^/]+)\/run$/);
      if (replRunMatch) {
        try {
          const result = await replicateTarget(buildReplicationDeps(ctx), replRunMatch[1], { trigger: 'manual' });
          sendJson(res, result.status === 'Failed' ? 502 : 200, result);
        } catch (err) {
          sendRepoError(res, err);
        }
        return;
      }

      const replPullMatch = req.method === 'POST' && pathname.match(/^\/replication-targets\/([^/]+)\/pull$/);
      if (replPullMatch) {
        try {
          const target = ctx.replicationTargetsRepo.getById(replPullMatch[1]);
          if (!target) {
            sendJson(res, 404, { error: 'not found' });
            return;
          }
          const body = await readJsonBody(req);
          const dest = resolvePath(String(body.dest ?? ''));
          if (!dest) {
            sendJson(res, 400, { error: 'A "dest" folder is required.' });
            return;
          }
          await mkdir(dest, { recursive: true });
          const remote = await resolveRcloneRemote(ctx, target);
          const cryptPassword = loadReplicationCryptPassword(ctx, target);
          await rcloneClient.withRcloneConfig(target, remote, cryptPassword, (configPath, remoteSection) =>
            rcloneClient.rcloneCopyDown({ configPath, remoteSection, remotePath: target.remotePath, destDir: dest })
          );
          sendJson(res, 200, { ok: true, dest });
        } catch (err) {
          sendJson(res, 502, { ok: false, error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      const replPatchMatch = req.method === 'PATCH' && pathname.match(/^\/replication-targets\/([^/]+)$/);
      if (replPatchMatch) {
        try {
          const body = await readJsonBody(req);
          ctx.replicationTargetsRepo.update(replPatchMatch[1], {
            enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
            remotePath: typeof body.remotePath === 'string' ? body.remotePath : undefined,
          });
          sendJson(res, 200, ctx.replicationTargetsRepo.getById(replPatchMatch[1]));
        } catch (err) {
          sendRepoError(res, err);
        }
        return;
      }

      const replDeleteMatch = req.method === 'POST' && pathname.match(/^\/replication-targets\/([^/]+)\/remove$/);
      if (replDeleteMatch) {
        ctx.replicationTargetsRepo.remove(replDeleteMatch[1]);
        sendJson(res, 200, { removed: replDeleteMatch[1] });
        return;
      }

      if (req.method === 'GET' && pathname === '/replication-runs') {
        const targetId = url.searchParams.get('target') ?? undefined;
        const limitParam = url.searchParams.get('limit');
        sendJson(
          res,
          200,
          ctx.replicationRunsRepo.listRecent({ targetId, limit: limitParam ? Number(limitParam) : 50 })
        );
        return;
      }

      sendJson(res, 404, { error: 'not found' });
    });

    // Without this, a bind failure (most commonly EADDRINUSE -- something
    // else on the machine already holds this port) is an unhandled 'error'
    // event on the underlying EventEmitter, which crashes the whole process
    // with an opaque, uncaught-exception stack trace -- in production this
    // is the Tauri sidecar, so that crash would be silent from the user's
    // perspective (the webview just gets connection-refused on every fetch,
    // no diagnostic anywhere). Same class of gotcha already documented and
    // fixed for the raw ssh2 Client in transports/sshAdapter.ts.
    //
    // On EADDRINUSE for the *preferred* port, fall back to an OS-assigned
    // free port (`listen(0, ...)`) instead of giving up outright -- a fixed
    // port can always collide with something else on a client's machine.
    // The actual bound port is then the one thing that matters to whoever
    // needs to reach this server, so it's logged on its own machine-readable
    // `PORT=<n>` line regardless of whether the preferred port or the
    // fallback was used; the production Tauri shell parses that line out of
    // the sidecar's stdout (see lib.rs) to learn where to actually point the
    // webview instead of assuming the preferred port was free.
    let usedFallback = false;
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && !usedFallback) {
        usedFallback = true;
        console.error(`Port ${port} is already in use on this machine -- falling back to an OS-assigned free port.`);
        server.listen(0, '127.0.0.1');
        return;
      }
      console.error(`Failed to start the local server: ${err.message}`);
      process.exit(1);
    });

    server.on('listening', () => {
      const addr = server.address();
      const actualPort = addr && typeof addr === 'object' ? addr.port : port;
      console.log(`PORT=${actualPort}`);
      console.log(`Serving dashboard status at http://127.0.0.1:${actualPort}/status (Ctrl+C to stop)`);
    });

    // Best-effort portable vault backup, ONLY while the vault is unlocked
    // (the LocalSystem scheduler can't do this — no DEK). Runs the targets
    // that are DUE (no recent-enough successful backup — see isVaultBackupDue),
    // so it doesn't depend on Arkode staying open for a full day and doesn't
    // re-generate a backup on every open/close within the freshness window.
    // The periodic re-check is just a safety net for a long-running session.
    let vaultSweepRunning = false;
    const runVaultBackupsQuietly = async () => {
      if (vaultSweepRunning || !ctx.vaultState.isUnlocked()) return;
      if (ctx.vaultBackupTargetsRepo.listEnabled().length === 0) return;
      vaultSweepRunning = true;
      try {
        await runDueVaultBackups(buildVaultBackupDeps(ctx));
      } catch (err) {
        console.error(`Vault backup sweep failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        vaultSweepRunning = false;
      }
    };
    setTimeout(() => void runVaultBackupsQuietly(), 30_000).unref();
    setInterval(() => void runVaultBackupsQuietly(), 3 * 60 * 60 * 1000).unref();

    // Arkode Pocket auto-publish: dirty is flipped instantly by SQL triggers
    // the moment a credential/URL changes (see pocket_state's migration),
    // but publishing on every single change would spam Drive on every edit
    // in an active editing session — so this only publishes once a pending
    // change has been sitting dirty for at least POCKET_DEBOUNCE_MS. This is
    // a bounded-STALENESS window (published within ~debounce minutes of the
    // FIRST unpublished change), not a sliding "wait for a quiet period"
    // debounce — deliberately, so a long active-editing session still gets
    // synced periodically instead of never publishing until it's over.
    // Checked every 60s; each check is one cheap DB read when not due.
    const POCKET_DEBOUNCE_MS = 3 * 60 * 1000;
    let pocketPublishRunning = false;
    const runPocketPublishQuietly = async () => {
      if (pocketPublishRunning || !ctx.vaultState.isUnlocked()) return;
      const state = ctx.pocketStateRepo.get();
      if (!state || !state.configured || !state.enabled || !state.dirty || !state.dirtySince) return;
      if (Date.now() - Date.parse(state.dirtySince) < POCKET_DEBOUNCE_MS) return;
      pocketPublishRunning = true;
      try {
        await runPocketPublish(buildPocketPublishDeps(ctx));
      } catch (err) {
        console.error(`Pocket publish sweep failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        pocketPublishRunning = false;
      }
    };
    setTimeout(() => void runPocketPublishQuietly(), 30_000).unref();
    setInterval(() => void runPocketPublishQuietly(), 60_000).unref();

    // Per-machine auto-unlock: if the user enabled it on this machine, open
    // the vault now with the DPAPI-CurrentUser-sealed KEK — no master
    // password. Stale/foreign material is deleted inside here and we fall
    // through to the normal locked state. Never blocks startup.
    try {
      if (ctx.vaultState.attemptStartupAutoUnlock()) {
        void runDueVaultBackups(buildVaultBackupDeps(ctx)).catch((err) =>
          console.error(`Vault backup catch-up failed: ${err instanceof Error ? err.message : String(err)}`)
        );
        void runPocketPublish(buildPocketPublishDeps(ctx)).catch((err) =>
          console.error(`Pocket publish catch-up failed: ${err instanceof Error ? err.message : String(err)}`)
        );
      }
    } catch (err) {
      console.error(`Vault auto-unlock at startup failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    server.listen(port, '127.0.0.1');
  });

// Re-hardens any pre-existing key file's ACL on every startup, not just new
// ones — covers keys copied/restored before this fix existed, which are
// still sitting with %PROGRAMDATA%'s overly-broad inherited ACL (see
// keyFilePermissions.ts's own doc comment for the full root cause). Cheap
// (a handful of small files) and idempotent, so unconditional-every-startup
// is simpler than tracking "have I migrated" state anywhere. Never fatal —
// one bad file (or no keys dir yet, e.g. before the first `migrate`)
// shouldn't block every other command from running.
async function hardenExistingKeysAtStartup(): Promise<void> {
  try {
    const result = await hardenExistingKeyStore();
    for (const { file, error } of result.errors) {
      console.error(`Warning: could not update permissions on key file "${file}": ${error}`);
    }
  } catch (err) {
    console.error(`Warning: could not check SSH key file permissions: ${err instanceof Error ? err.message : String(err)}`);
  }
}

hardenExistingKeysAtStartup()
  .then(() => program.parseAsync(process.argv))
  .catch((err) => {
    // A clean one-line error instead of a raw stack trace for anything an
    // individual command didn't already catch itself (e.g. a schtasks.exe
    // failure) — this is a CLI meant to be scripted/read by a human, not a
    // stack-trace dump.
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
