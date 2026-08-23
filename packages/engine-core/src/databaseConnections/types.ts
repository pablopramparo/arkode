import type { DatabaseEngine } from '../types.js';

/**
 * NOT IMPLEMENTED — these interfaces exist only to shape the direct_dump
 * strategy's future dependency so the schema/orchestrator don't need to
 * change again when it's built. See §1/§11 of the architecture plan for why
 * this needs real DB credentials (unlike fetch_existing/remote_dump).
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
