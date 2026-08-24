import type { DatabaseConnection } from '../types.js';
import type { SecretStore } from '../secrets/types.js';
import type { ConnectionTestResult } from '../transports/types.js';
import type { DatabaseConnectionConfig } from './types.js';
import { createPostgresConnectionTester } from './postgresConnectionTester.js';
import { createMysqlConnectionTester } from './mysqlConnectionTester.js';

/**
 * Tests a direct_dump database connection without producing a dump —
 * resolves the password from SecretStore and dispatches to the
 * engine-specific tester, mirroring how transports expose testConnection().
 */
export async function testDatabaseConnection(
  connection: DatabaseConnection,
  secretStore: SecretStore
): Promise<ConnectionTestResult> {
  const password = connection.passwordSecretRef ? (secretStore.get(connection.passwordSecretRef) ?? undefined) : undefined;

  const config: DatabaseConnectionConfig = {
    engine: connection.engine,
    host: connection.host,
    port: connection.port,
    databaseName: connection.databaseName,
    username: connection.username,
    password,
    sslMode: connection.sslMode ? (connection.sslMode as DatabaseConnectionConfig['sslMode']) : undefined,
  };

  const tester =
    connection.engine === 'postgres' ? createPostgresConnectionTester() : createMysqlConnectionTester();
  return tester(config);
}
