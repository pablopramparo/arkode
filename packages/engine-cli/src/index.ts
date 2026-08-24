#!/usr/bin/env node
import { Command } from 'commander';
import { randomUUID } from 'node:crypto';
import {
  runBackupTask,
  createSftpAdapterFromTransport,
  createSshAdapterFromTransport,
  type DbEngine,
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
  .action((opts) => {
    const ctx = buildContext();
    const client = ctx.clientsRepo.create({
      name: opts.name,
      description: opts.description ?? null,
      localBasePath: opts.localBasePath,
    });
    console.log(JSON.stringify(client, null, 2));
  });

function resolvePassphraseSecretRef(ctx: ReturnType<typeof buildContext>, passphrase: string | undefined): string | null {
  if (!passphrase) return null;
  const ref = `transport:${randomUUID()}:passphrase`;
  ctx.secretStore.set(ref, passphrase);
  return ref;
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
  .command('task:create')
  .description('Create a backup task (fetch_existing or remote_dump, matching the transport\'s type).')
  .requiredOption('--client <clientId>')
  .requiredOption('--transport <transportId>')
  .requiredOption('--name <name>')
  .option('--strategy <strategy>', 'fetch_existing | remote_dump', 'fetch_existing')
  .option('--db-engine <engine>', 'postgres | mysql | unknown', 'unknown')
  .action((opts) => {
    const ctx = buildContext();
    const input = {
      clientId: opts.client,
      transportId: opts.transport,
      name: opts.name,
      dbEngine: opts.dbEngine as DbEngine,
    };
    const task =
      opts.strategy === 'remote_dump'
        ? ctx.tasksRepo.createRemoteDump(input)
        : ctx.tasksRepo.createFetchExisting(input);
    console.log(JSON.stringify(task, null, 2));
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
      runsRepo: ctx.runsRepo,
      logEventsRepo: ctx.logEventsRepo,
      knownHostsRepo: ctx.knownHostsRepo,
      secretStore: ctx.secretStore,
      onUnknownHost: confirmHostInteractively,
    });

    console.log(JSON.stringify(result.run, null, 2));
    if (result.run.status === 'Failed') process.exitCode = 1;
  });

program
  .command('task:test-connection')
  .description('Test a task\'s transport connection without running a backup.')
  .argument('<taskId>')
  .action(async (taskId: string) => {
    const ctx = buildContext();
    const task = ctx.tasksRepo.getById(taskId);
    if (!task) {
      console.error(`Task ${taskId} not found.`);
      process.exitCode = 1;
      return;
    }
    if (!task.transportId) {
      console.error(`Task ${taskId} has no transport configured (strategy: ${task.strategy}).`);
      process.exitCode = 1;
      return;
    }
    const transport = ctx.transportsRepo.getById(task.transportId);
    if (!transport) {
      console.error(`Transport ${task.transportId} not found.`);
      process.exitCode = 1;
      return;
    }

    const adapter =
      transport.type === 'ssh'
        ? createSshAdapterFromTransport(transport, ctx.secretStore, ctx.knownHostsRepo, confirmHostInteractively)
        : createSftpAdapterFromTransport(transport, ctx.secretStore, ctx.knownHostsRepo, confirmHostInteractively);
    const result = await adapter.testConnection();
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
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
