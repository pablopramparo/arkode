import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveBundledToolPath, resolveToolPath } from '../toolPaths.js';

/**
 * MySQL and MariaDB share a wire protocol but their command-line tools
 * diverge in real ways:
 *
 *  - SSL flags: `mysqldump`/`mysql` use
 *    `--ssl-mode=DISABLED|REQUIRED|VERIFY_IDENTITY`; `mariadb-dump`/`mariadb`
 *    have no `--ssl-mode` at all and use a boolean `--ssl`/`--skip-ssl`.
 *  - Auth plugins: the MariaDB client can only authenticate to a modern
 *    MySQL 8/9 server (default `caching_sha2_password`) if pointed at a
 *    plugin dir that contains `caching_sha2_password.dll` — confirmed by
 *    hand. arkode vendors that plugin next to the bundled `mariadb.exe`
 *    (resources/mariadb/plugin/), passed via `--plugin-dir`.
 *
 * arkode bundles the MariaDB family (see toolPaths.ts) as the zero-config
 * tooling for BOTH engines, so callers must know which flavor they actually
 * resolved and get any binary-specific args (`--plugin-dir`) prepended.
 */
export type MysqlClientFlavor = 'mysql' | 'mariadb';

export interface ResolvedMysqlBinary {
  path: string;
  flavor: MysqlClientFlavor;
  /** Args every invocation of this binary needs (currently `--plugin-dir` for a bundled MariaDB binary with a sibling plugin/ dir). Prepend to the arg list. */
  extraArgs: string[];
}

/** By basename: a `mariadb.exe` / `mariadb-dump.exe` path is the MariaDB flavor. */
export function isMariaDbBinary(binPath: string): boolean {
  return /(^|[\\/])mariadb(-dump)?(\.exe)?$/i.test(binPath.trim());
}

function extraArgsFor(binPath: string): string[] {
  if (!isMariaDbBinary(binPath)) return [];
  const pluginDir = join(dirname(binPath), 'plugin');
  return existsSync(join(pluginDir, 'caching_sha2_password.dll')) ? [`--plugin-dir=${pluginDir}`] : [];
}

function describe(path: string | undefined): ResolvedMysqlBinary | undefined {
  if (!path) return undefined;
  return { path, flavor: isMariaDbBinary(path) ? 'mariadb' : 'mysql', extraArgs: extraArgsFor(path) };
}

/**
 * The interactive client (`mysql.exe` / `mariadb.exe`) for connection tests
 * and `SELECT VERSION()`: MYSQL_CLI_PATH if set, else the bundled MariaDB
 * client next to engine-cli.exe, else undefined. `mysql.exe` is never
 * vendored (Oracle) — `mariadb.exe` handles a `SELECT 1` against a MySQL
 * server fine (with the bundled auth plugins).
 */
export function resolveMysqlFamilyCli(explicit?: string): ResolvedMysqlBinary | undefined {
  return describe(explicit ?? resolveToolPath('MYSQL_CLI_PATH', 'mysql.exe') ?? resolveBundledToolPath('mariadb.exe'));
}

/**
 * The dumper for a `mariadb`-engine task, or a `mysql`-engine task with no
 * real mysqldump configured: MARIADB_DUMP_PATH if set, else the bundled
 * `mariadb-dump.exe`.
 */
export function resolveMariaDbFamilyDump(explicit?: string): ResolvedMysqlBinary | undefined {
  return describe(explicit ?? resolveToolPath('MARIADB_DUMP_PATH', 'mariadb-dump.exe') ?? resolveBundledToolPath('mariadb-dump.exe'));
}

/**
 * SSL command-line args for a `mysql`/`mariadb` family binary, correct for
 * the given flavor. Empty when no explicit sslMode is set (let the client
 * use its own default).
 */
export function mysqlFamilySslArgs(flavor: MysqlClientFlavor, sslMode: string | null | undefined): string[] {
  if (!sslMode) return [];
  if (flavor === 'mariadb') {
    if (sslMode === 'disable') return ['--skip-ssl'];
    if (sslMode === 'require') return ['--ssl'];
    if (sslMode === 'verify-full') return ['--ssl', '--ssl-verify-server-cert'];
    return [];
  }
  if (sslMode === 'disable') return ['--ssl-mode=DISABLED'];
  if (sslMode === 'require') return ['--ssl-mode=REQUIRED'];
  if (sslMode === 'verify-full') return ['--ssl-mode=VERIFY_IDENTITY'];
  return [];
}

/** `--plugin-dir` (or similar) args for a specific already-resolved binary path — for callers that resolved the path themselves (e.g. a version-keyed registry). */
export function mysqlBinaryExtraArgs(binPath: string): string[] {
  return extraArgsFor(binPath);
}
