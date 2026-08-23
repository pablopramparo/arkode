#!/usr/bin/env node
import { Command } from 'commander';
import { randomUUID } from 'node:crypto';
import { runBackupTask, createSftpAdapterFromTransport, type DbEngine } from 'engine-core';
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

program
  .command('transport:create')
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

    let passphraseSecretRef: string | null = null;
    if (opts.passphrase) {
      passphraseSecretRef = `transport:${randomUUID()}:passphrase`;
      ctx.secretStore.set(passphraseSecretRef, opts.passphrase);
    }

    const transport = ctx.transportsRepo.createSftp({
      clientId: opts.client,
      name: opts.name,
      host: opts.host,
      port: Number(opts.port),
      username: opts.username,
      privateKeyPath: opts.privateKeyPath,
      passphraseSecretRef,
      remotePath: opts.remotePath,
      remoteFilePattern: opts.remoteFilePattern ?? null,
    });
    console.log(JSON.stringify(transport, null, 2));
  });

program
  .command('task:create')
  .description('Create a fetch_existing backup task.')
  .requiredOption('--client <clientId>')
  .requiredOption('--transport <transportId>')
  .requiredOption('--name <name>')
  .option('--db-engine <engine>', 'postgres | mysql | unknown', 'unknown')
  .action((opts) => {
    const ctx = buildContext();
    const task = ctx.tasksRepo.createFetchExisting({
      clientId: opts.client,
      transportId: opts.transport,
      name: opts.name,
      dbEngine: opts.dbEngine as DbEngine,
    });
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

    const adapter = createSftpAdapterFromTransport(
      transport,
      ctx.secretStore,
      ctx.knownHostsRepo,
      confirmHostInteractively
    );
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
