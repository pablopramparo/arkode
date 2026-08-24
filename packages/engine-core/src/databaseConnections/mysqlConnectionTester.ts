import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ConnectionTestResult } from '../transports/types.js';
import type { DatabaseConnectionConfig } from './types.js';

const execFileAsync = promisify(execFile);

/**
 * Tests connectivity + authentication without producing a dump: runs a
 * trivial query via the `mysql` CLI client, bundled alongside `mysqldump` in
 * the same MySQL bin directory. Dev-time path via MYSQL_CLI_PATH env var
 * (named distinctly from MYSQLDUMP_PATH — they're two different binaries).
 */
export function createMysqlConnectionTester(mysqlPath: string | undefined = process.env.MYSQL_CLI_PATH) {
  return async function testMysqlConnection(config: DatabaseConnectionConfig): Promise<ConnectionTestResult> {
    if (!mysqlPath) {
      return { ok: false, message: 'MYSQL_CLI_PATH is not configured — cannot test the connection.' };
    }

    const args = ['--host', config.host, '--port', String(config.port), '--user', config.username];
    if (config.sslMode === 'disable') args.push('--ssl-mode=DISABLED');
    else if (config.sslMode === 'require') args.push('--ssl-mode=REQUIRED');
    else if (config.sslMode === 'verify-full') args.push('--ssl-mode=VERIFY_IDENTITY');
    args.push('--execute=SELECT 1', config.databaseName);

    const env: NodeJS.ProcessEnv = { ...process.env };
    if (config.password) env.MYSQL_PWD = config.password;

    const startedAt = Date.now();
    try {
      await execFileAsync(mysqlPath, args, { env });
      return { ok: true, message: 'Connection succeeded.', latencyMs: Date.now() - startedAt };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  };
}
