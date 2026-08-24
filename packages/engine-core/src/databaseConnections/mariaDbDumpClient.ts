import type { DatabaseDumpClient, DatabaseConnectionConfig } from './types.js';

/**
 * NOT IMPLEMENTED — MariaDB is wire-compatible with MySQL (the same
 * connection/auth path works today via createMysqlConnectionTester), but is
 * NOT assumed interchangeable at the dump-tool level: `mariadb-dump` is a
 * distinct binary from `mysqldump`, and version-compatibility rules between
 * a MariaDB server and either tool differ from MySQL's. This stub exists so
 * the engine type/dispatch already distinguishes 'mariadb' from 'mysql' —
 * see types.ts's DatabaseEngine comment — without committing to how
 * detection/tool-selection actually works yet. Do not implement without an
 * explicit go-ahead; see CLAUDE.md's "direct_dump tool version management"
 * note for the intended shape (server-version detection + compatible local
 * tool selection, encapsulated entirely inside this client).
 */
export function createMariaDbDumpClient(): DatabaseDumpClient {
  return {
    engine: 'mariadb',
    async dump(_config: DatabaseConnectionConfig, _localTempPath: string): Promise<{ sizeBytes: number }> {
      throw new Error('mariadb direct_dump is not implemented yet.');
    },
  };
}
