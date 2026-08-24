import type { DatabaseEngine } from '../types.js';

/**
 * Shapes the direct_dump strategy's dependency on real DB credentials
 * (unlike fetch_existing/remote_dump, which never need them). See
 * postgresDumpClient.ts / mysqlDumpClient.ts for the implementations.
 */
export interface DatabaseConnectionConfig {
  engine: DatabaseEngine;
  host: string;
  port: number;
  databaseName: string;
  username: string;
  /** Resolved from SecretStore by the caller — never persisted or read here. */
  password?: string;
  sslMode?: 'disable' | 'require' | 'verify-full';
}

/** Runs a local dump binary (pg_dump/mysqldump) against a remote DB, writing straight to disk. */
export interface DatabaseDumpClient {
  readonly engine: DatabaseEngine;
  dump(config: DatabaseConnectionConfig, localTempPath: string): Promise<{ sizeBytes: number }>;
}
