#!/usr/bin/env node
import { Command } from 'commander';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { basename } from 'node:path';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  runBackupTask,
  createSftpAdapterFromTransport,
  createSshAdapterFromTransport,
  testDatabaseConnection,
  exportConfig,
  importConfig,
  runDueTasks,
  scheduledTaskNameForBackupTask,
  installScheduledTask,
  uninstallScheduledTask,
  scheduledTaskStatus,
  getDashboardStatus,
  getSystemInfo,
  copyPrivateKeyIntoAppStorage,
  createPostgresToolRegistry,
  createMysqlToolRegistry,
  createMariaDbToolRegistry,
  testDirectDumpCompatibility,
  type DbEngine,
  type Transport,
  type ConnectionTestResult,
  type ConfigExport,
  type RunBackupTaskDeps,
  type BackupTask,
  type DirectDumpCompatibilityResult,
} from 'engine-core';
import { buildContext } from './context.js';
import { confirmHostInteractively } from './confirmHost.js';

const program = new Command();
program.name('engine-cli').description('Codebius Backup Manager engine CLI').version('0.0.0');

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

function resolveSecretRef(ctx: ReturnType<typeof buildContext>, value: string | undefined, refPrefix: string): string | null {
  if (!value) return null;
  const ref = `${refPrefix}:${randomUUID()}`;
  ctx.secretStore.set(ref, value);
  return ref;
}

function resolvePassphraseSecretRef(ctx: ReturnType<typeof buildContext>, passphrase: string | undefined): string | null {
  return resolveSecretRef(ctx, passphrase, 'transport:passphrase');
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
  .requiredOption('--remote-path <remotePath>')
  .option('--remote-file-pattern <regex>')
  .option('--passphrase <passphrase>', 'SSH key passphrase — stored via Windows Credential Manager, never in SQLite')
  .action((opts) => {
    const ctx = buildContext();
    const transport = ctx.transportsRepo.createSftp({
      clientId: opts.client,
      name: opts.name,
      host: opts.host,
      port: Number(opts.port),
      username: opts.username,
      privateKeyPath: copyPrivateKeyIntoAppStorage(opts.privateKeyPath),
      passphraseSecretRef: resolvePassphraseSecretRef(ctx, opts.passphrase),
      remotePath: opts.remotePath,
      remoteFilePattern: opts.remoteFilePattern ?? null,
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
  .requiredOption('--remote-command <command>', 'command that produces the dump on the remote host')
  .requiredOption(
    '--remote-output-path-template <template>',
    'expected produced-file path, e.g. /tmp/backups/winners_{date:YYYYMMDD_HHmm}.dump'
  )
  .option('--remote-cleanup', 'delete the remote file after a successful download', false)
  .option('--passphrase <passphrase>', 'SSH key passphrase — stored via Windows Credential Manager, never in SQLite')
  .action((opts) => {
    const ctx = buildContext();
    const transport = ctx.transportsRepo.createSsh({
      clientId: opts.client,
      name: opts.name,
      host: opts.host,
      port: Number(opts.port),
      username: opts.username,
      privateKeyPath: copyPrivateKeyIntoAppStorage(opts.privateKeyPath),
      passphraseSecretRef: resolvePassphraseSecretRef(ctx, opts.passphrase),
      remoteCommand: opts.remoteCommand,
      remoteOutputPathTemplate: opts.remoteOutputPathTemplate,
      remoteCleanup: Boolean(opts.remoteCleanup),
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
  .option('--remote-path <remotePath>', 'sftp only')
  .option('--remote-file-pattern <regex>', 'sftp only')
  .option('--remote-command <command>', 'ssh only')
  .option('--remote-output-path-template <template>', 'ssh only')
  .option('--remote-cleanup <bool>', 'ssh only: true|false')
  .action((transportId: string, opts) => {
    const ctx = buildContext();
    const transport = ctx.transportsRepo.update(transportId, {
      name: opts.name,
      host: opts.host,
      port: opts.port != null ? Number(opts.port) : undefined,
      username: opts.username,
      privateKeyPath: opts.privateKeyPath ? copyPrivateKeyIntoAppStorage(opts.privateKeyPath) : undefined,
      passphraseSecretRef: opts.passphrase ? resolvePassphraseSecretRef(ctx, opts.passphrase) : undefined,
      remotePath: opts.remotePath,
      remoteFilePattern: opts.remoteFilePattern,
      remoteCommand: opts.remoteCommand,
      remoteOutputPathTemplate: opts.remoteOutputPathTemplate,
      remoteCleanup: opts.remoteCleanup != null ? opts.remoteCleanup === 'true' : undefined,
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
  .option('--retention-count <n>', 'override the client default: keep the last N Success backups for this task')
  .option('--retention-days <n>', 'override the client default: keep backups from the last N days for this task')
  .action((opts) => {
    const ctx = buildContext();
    const dbEngine = opts.dbEngine as DbEngine;
    const retentionCount = opts.retentionCount != null ? Number(opts.retentionCount) : null;
    const retentionDays = opts.retentionDays != null ? Number(opts.retentionDays) : null;

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
      });
      console.log(JSON.stringify(task, null, 2));
      return;
    }

    if (!opts.transport) {
      console.error(`${opts.strategy} tasks require --transport <id>.`);
      process.exitCode = 1;
      return;
    }
    const input = { clientId: opts.client, transportId: opts.transport, name: opts.name, dbEngine, retentionCount, retentionDays };
    const task =
      opts.strategy === 'remote_dump' ? ctx.tasksRepo.createRemoteDump(input) : ctx.tasksRepo.createFetchExisting(input);
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
  .description("Update a task's name/retention (not its strategy/transport/database-connection/db-engine — create a new task to change any of those). Only the flags you pass are changed.")
  .argument('<taskId>')
  .option('--name <name>')
  .option('--retention-count <n>')
  .option('--retention-days <n>')
  .action((taskId: string, opts) => {
    const ctx = buildContext();
    const task = ctx.tasksRepo.update(taskId, {
      name: opts.name,
      retentionCount: opts.retentionCount != null ? Number(opts.retentionCount) : undefined,
      retentionDays: opts.retentionDays != null ? Number(opts.retentionDays) : undefined,
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

function testTransportConnection(ctx: ReturnType<typeof buildContext>, transport: Transport): Promise<ConnectionTestResult> {
  const adapter =
    transport.type === 'ssh'
      ? createSshAdapterFromTransport(transport, ctx.secretStore, ctx.knownHostsRepo, confirmHostInteractively)
      : createSftpAdapterFromTransport(transport, ctx.secretStore, ctx.knownHostsRepo, confirmHostInteractively);
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

/** Shared by the `task:test-connection` CLI command and the `serve` HTTP endpoint. Throws if the task or its transport/database connection can't be resolved. */
async function testTaskConnection(ctx: ReturnType<typeof buildContext>, task: NonNullable<ReturnType<typeof ctx.tasksRepo.getById>>): Promise<ConnectionTestResult> {
  if (task.strategy === 'direct_dump') {
    const connection = task.databaseConnectionId ? ctx.databaseConnectionsRepo.getById(task.databaseConnectionId) : null;
    if (!connection) throw new Error(`Task ${task.id} has no valid database connection configured.`);
    return testDatabaseConnection(connection, ctx.secretStore);
  }
  const transport = task.transportId ? ctx.transportsRepo.getById(task.transportId) : null;
  if (!transport) throw new Error(`Task ${task.id} has no valid transport configured.`);
  return testTransportConnection(ctx, transport);
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
      secretStore: ctx.secretStore,
      // An unattended run has no interactive terminal, so this correctly
      // (and intentionally) rejects any host that isn't already known —
      // never silently trusting a new host just because nobody's watching.
      onUnknownHost: confirmHostInteractively,
    };

    const results = await runDueTasks(tasks, deps, new Date());
    console.log(JSON.stringify(results, null, 2));
    if (results.some((r) => r.error || r.result?.run.status === 'Failed')) process.exitCode = 1;
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

    const taskName = scheduledTaskNameForBackupTask(taskId);
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
      description: `Codebius Backup Manager - scheduled run for task "${task.name}"`,
      scheduleTime: task.scheduleTime,
      command: process.execPath,
      arguments: isPkgExe ? `run-due --task ${taskId}` : `"${scriptPath}" run-due --task ${taskId}`,
    });

    console.log(`Registered Windows Scheduled Task "${taskName}" for task "${task.name}" at ${task.scheduleTime} daily, running as SYSTEM.`);
  });

program
  .command('scheduler:uninstall')
  .description("Remove a task's Windows Scheduled Task.")
  .argument('<taskId>')
  .action(async (taskId: string) => {
    const taskName = scheduledTaskNameForBackupTask(taskId);
    await uninstallScheduledTask(taskName);
    console.log(`Removed Windows Scheduled Task "${taskName}".`);
  });

program
  .command('scheduler:status')
  .description("Check whether a task's Windows Scheduled Task is registered.")
  .argument('<taskId>')
  .action(async (taskId: string) => {
    const taskName = scheduledTaskNameForBackupTask(taskId);
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
  .command('serve')
  .description(
    'Start a local HTTP server exposing dashboard status (GET /status) and per-task actions (run now, test connection) for the UI. Dev-only for now — see CLAUDE.md.'
  )
  .option('--port <port>', 'default 4287', '4287')
  .action((opts) => {
    const ctx = buildContext();
    const port = Number(opts.port);

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
            const result = await testTaskConnection(ctx, task);
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

      if (req.method === 'GET' && pathname === '/connections') {
        const includeInactive = url.searchParams.get('includeInactive') === 'true';
        const clients = ctx.clientsRepo.listActive();
        const transports = clients.flatMap((client) =>
          ctx.transportsRepo
            .listByClient(client.id)
            .filter((t) => includeInactive || t.isActive)
            .map((t) => ({ ...t, clientName: client.name }))
        );
        const databaseConnections = clients.flatMap((client) =>
          ctx.databaseConnectionsRepo
            .listByClient(client.id)
            .filter((d) => includeInactive || d.isActive)
            .map((d) => ({ ...d, clientName: client.name }))
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
          if (!body.clientId || !body.name || !body.host || !body.username || !body.privateKeyPath) {
            sendJson(res, 400, { error: 'clientId, name, host, username, and privateKeyPath are required.' });
            return;
          }
          const passphraseSecretRef = resolvePassphraseSecretRef(ctx, body.passphrase);
          const privateKeyPath = copyPrivateKeyIntoAppStorage(body.privateKeyPath);
          let transport;
          if (body.type === 'ssh') {
            if (!body.remoteCommand || !body.remoteOutputPathTemplate) {
              sendJson(res, 400, { error: 'remoteCommand and remoteOutputPathTemplate are required for an ssh transport.' });
              return;
            }
            transport = ctx.transportsRepo.createSsh({
              clientId: body.clientId,
              name: body.name,
              host: body.host,
              port: body.port,
              username: body.username,
              privateKeyPath,
              passphraseSecretRef,
              remoteCommand: body.remoteCommand,
              remoteOutputPathTemplate: body.remoteOutputPathTemplate,
              remoteCleanup: Boolean(body.remoteCleanup),
            });
          } else {
            if (!body.remotePath) {
              sendJson(res, 400, { error: 'remotePath is required for an sftp transport.' });
              return;
            }
            transport = ctx.transportsRepo.createSftp({
              clientId: body.clientId,
              name: body.name,
              host: body.host,
              port: body.port,
              username: body.username,
              privateKeyPath,
              passphraseSecretRef,
              remotePath: body.remotePath,
              remoteFilePattern: body.remoteFilePattern ?? null,
            });
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
          const result = await testTransportConnection(ctx, transport);
          sendJson(res, result.ok ? 200 : 502, result);
        } catch (err) {
          sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      const transportIdMatch = req.method === 'PATCH' && pathname.match(/^\/transports\/([^/]+)$/);
      if (transportIdMatch) {
        try {
          const { passphrase, ...rest } = await readJsonBody(req);
          const patch: Record<string, unknown> = { ...rest };
          if (passphrase) patch.passphraseSecretRef = resolvePassphraseSecretRef(ctx, passphrase);
          if (patch.privateKeyPath) patch.privateKeyPath = copyPrivateKeyIntoAppStorage(patch.privateKeyPath as string);
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
              return {
                ...t,
                clientName: client.name,
                transportName: transport?.name ?? null,
                databaseConnectionName: databaseConnection?.name ?? null,
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
          return { ...run, clientName: client?.name ?? null, taskName: task?.name ?? null };
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
        const enriched = runs.map((run) => {
          const client = ctx.clientsRepo.getById(run.clientId);
          const task = ctx.tasksRepo.getById(run.taskId);
          return { ...run, clientName: client?.name ?? null, taskName: task?.name ?? null };
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

      if (req.method === 'GET' && pathname === '/logs') {
        const limitParam = url.searchParams.get('limit');
        const offsetParam = url.searchParams.get('offset');
        const { events, total } = ctx.logEventsRepo.listRecent({
          search: url.searchParams.get('search') ?? undefined,
          step: url.searchParams.get('step') ?? undefined,
          level: (url.searchParams.get('level') as any) ?? undefined,
          from: url.searchParams.get('from') ?? undefined,
          to: url.searchParams.get('to') ?? undefined,
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

      if (req.method === 'GET' && pathname === '/system') {
        sendJson(res, 200, getSystemInfo());
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
            });
          } else {
            if (!body.transportId) {
              sendJson(res, 400, { error: `${body.strategy} tasks require transportId.` });
              return;
            }
            const input = { clientId: body.clientId, transportId: body.transportId, name: body.name, dbEngine, retentionCount, retentionDays };
            task = body.strategy === 'remote_dump' ? ctx.tasksRepo.createRemoteDump(input) : ctx.tasksRepo.createFetchExisting(input);
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

      sendJson(res, 404, { error: 'not found' });
    });

    server.listen(port, '127.0.0.1', () => {
      console.log(`Serving dashboard status at http://127.0.0.1:${port}/status (Ctrl+C to stop)`);
    });
  });

program.parseAsync(process.argv).catch((err) => {
  // A clean one-line error instead of a raw stack trace for anything an
  // individual command didn't already catch itself (e.g. a schtasks.exe
  // failure) — this is a CLI meant to be scripted/read by a human, not a
  // stack-trace dump.
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
