import { describe, expect, it } from 'vitest';
import { buildDockerDumpCommand } from '../../src/strategies/remoteDumpExecutor.js';
import type { BackupTask } from '../../src/types.js';

function fixtureTask(overrides: Partial<BackupTask>): BackupTask {
  return {
    id: 'task-1',
    clientId: 'client-1',
    strategy: 'remote_dump',
    transportId: 'transport-1',
    databaseConnectionId: null,
    name: 'Test task',
    dbEngine: 'postgres',
    remotePath: null,
    remoteFilePattern: null,
    remoteCommand: null,
    remoteOutputPathTemplate: '/home/arkode-backup/{date:YYYYMMDD}.dump',
    remoteCleanup: false,
    remoteDumpExecMode: 'docker',
    dockerContainer: 'my-container',
    remoteDumpDatabase: 'grupocarena_erp',
    remoteDumpDbUser: 'postgres',
    remoteDumpDbPasswordSecretRef: null,
    scheduleTime: null,
    scheduleEnabled: true,
    scheduleFrequency: 'daily',
    scheduleDaysOfWeek: null,
    scheduleDayOfMonth: null,
    retentionCount: null,
    retentionDays: null,
    isActive: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    backupSetId: null,
    ...overrides,
  };
}

describe('buildDockerDumpCommand', () => {
  it('builds the wrapper invocation for postgres, matching the real proven-working docker exec pattern', () => {
    const task = fixtureTask({ dbEngine: 'postgres', dockerContainer: 'u088ggocosggggg4skws8ssc', remoteDumpDatabase: 'grupocarena_erp', remoteDumpDbUser: 'postgres' });
    const command = buildDockerDumpCommand(task, '/home/arkode-backup/grupocarena_erp_20260826.dump');
    expect(command).toBe(
      "sudo /usr/local/sbin/arkode-dump --engine postgres --container 'u088ggocosggggg4skws8ssc' --database 'grupocarena_erp' --user 'postgres' > '/home/arkode-backup/grupocarena_erp_20260826.dump'"
    );
  });

  it('builds the wrapper invocation for mysql', () => {
    const task = fixtureTask({ dbEngine: 'mysql', dockerContainer: 'mysql-c1', remoteDumpDatabase: 'rivera_web', remoteDumpDbUser: 'root' });
    const command = buildDockerDumpCommand(task, '/home/arkode-backup/rivera_web.sql');
    expect(command).toBe(
      "sudo /usr/local/sbin/arkode-dump --engine mysql --container 'mysql-c1' --database 'rivera_web' --user 'root' > '/home/arkode-backup/rivera_web.sql'"
    );
  });

  it('shell-quotes every configured value individually — a container/database name with shell metacharacters cannot break out of its own argument', () => {
    const task = fixtureTask({ dockerContainer: "evil'; rm -rf / #", remoteDumpDatabase: 'db', remoteDumpDbUser: 'user' });
    const command = buildDockerDumpCommand(task, '/tmp/out.dump');
    expect(command).toContain("--container 'evil'\\''; rm -rf / #'");
    // The quoting neutralizes it into one literal argument — no unescaped ';' sits outside quotes.
    expect(command.replace(/'[^']*(?:'\\''[^']*)*'/g, '')).not.toMatch(/;/);
  });

  it('shell-quotes the resolved output path too, in case it contains spaces', () => {
    const task = fixtureTask({});
    const command = buildDockerDumpCommand(task, '/home/arkode-backup/my client/dump.dump');
    expect(command).toContain("> '/home/arkode-backup/my client/dump.dump'");
  });
});
