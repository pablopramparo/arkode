#!/usr/bin/env node
import { Command } from 'commander';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import {
  runBackupTask,
  createSftpAdapterFromTransport,
  createSshAdapterFromTransport,
  testDatabaseConnection,
  exportConfig,
  importConfig,
  type DbEngine,
  type Transport,
  type ConnectionTestResult,
  type ConfigExport,
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
      privateKeyPath: opts.privateKeyPath,
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
      privateKeyPath: opts.privateKeyPath,
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

    const result = await runBackupTask(task, {
      clientsRepo: ctx.clientsRepo,
      transportsRepo: ctx.transportsRepo,
      databaseConnectionsRepo: ctx.databaseConnectionsRepo,
      runsRepo: ctx.runsRepo,
      logEventsRepo: ctx.logEventsRepo,
      knownHostsRepo: ctx.knownHostsRepo,
      retentionDeletionsRepo: ctx.retentionDeletionsRepo,
      secretStore: ctx.secretStore,
      onUnknownHost: confirmHostInteractively,
    });

    console.log(JSON.stringify(result.run, null, 2));
    if (result.run.status === 'Failed') process.exitCode = 1;
  });

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

    let result: ConnectionTestResult;
    if (task.strategy === 'direct_dump') {
      const connection = task.databaseConnectionId ? ctx.databaseConnectionsRepo.getById(task.databaseConnectionId) : null;
      if (!connection) {
        console.error(`Task ${taskId} has no valid database connection configured.`);
        process.exitCode = 1;
        return;
      }
      result = await testDatabaseConnection(connection, ctx.secretStore);
    } else {
      const transport = task.transportId ? ctx.transportsRepo.getById(task.transportId) : null;
      if (!transport) {
        console.error(`Task ${taskId} has no valid transport configured.`);
        process.exitCode = 1;
        return;
      }
      result = await testTransportConnection(ctx, transport);
    }

    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
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
    const rows = ctx.clientsRepo.listActive().flatMap((client) =>
      ctx.tasksRepo.listByClient(client.id).map((task) => {
        const latestRun = ctx.runsRepo.getLatestByTask(task.id);
        return {
          client: client.name,
          task: task.name,
          strategy: task.strategy,
          status: latestRun?.status ?? 'NeverRun',
          sizeBytes: latestRun?.sizeBytes ?? null,
          checksumSha256: latestRun?.checksumSha256 ?? null,
          finishedAt: latestRun?.finishedAt ?? null,
        };
      })
    );

    if (opts.json) {
      console.log(JSON.stringify(rows, null, 2));
    } else {
      console.table(rows);
    }
  });

program.parseAsync(process.argv);
