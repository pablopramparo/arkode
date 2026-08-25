import type { SettingsRepo } from '../db/repositories/settingsRepo.js';

export interface MariaDbToolPaths {
  mariaDbDumpPath: string;
}

const SETTINGS_KEY = 'mariaDbToolRegistry';

export interface MariaDbToolRegistry {
  /** Every registered entry, keyed by major.minor version (e.g. "10.11", "11.5"). */
  list(): Record<string, MariaDbToolPaths>;
  /** Registers (or replaces) the mariadb-dump path for a given major.minor version. */
  register(majorMinorVersion: string, paths: MariaDbToolPaths): void;
  /** Removes a registered major.minor version, if present — a no-op otherwise. */
  unregister(majorMinorVersion: string): void;
  /** Looks up the entry matching a detected server version string (e.g. "11.5.2-MariaDB"). Returns null if nothing is registered for that major.minor version — callers should fall back to a single default path in that case. */
  resolve(serverVersion: string): MariaDbToolPaths | null;
}

/**
 * MariaDB versions its release series as major.minor (10.6, 10.11, 11.4,
 * 11.5, ...) — each series is its own support/compatibility branch, same
 * reasoning as MySQL's major.minor scheme (see mysqlToolRegistry.ts). So
 * "11.5.2-MariaDB" needs "11.5" as its registry key. The trailing "-MariaDB"
 * text doesn't need special handling — the regex just stops at the first
 * non-digit after the minor version.
 */
export function extractMariaDbMajorMinorVersion(serverVersion: string): string {
  const match = serverVersion.match(/^(\d+)\.(\d+)/);
  return match ? `${match[1]}.${match[2]}` : serverVersion;
}

function readAll(settingsRepo: SettingsRepo): Record<string, MariaDbToolPaths> {
  const raw = settingsRepo.get(SETTINGS_KEY);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, MariaDbToolPaths>;
  } catch {
    return {};
  }
}

function writeAll(settingsRepo: SettingsRepo, registry: Record<string, MariaDbToolPaths>): void {
  settingsRepo.set(SETTINGS_KEY, JSON.stringify(registry));
}

/**
 * A registry of mariadb-dump paths keyed by MariaDB major.minor version,
 * backed by the existing `app_settings` key-value table — the same pattern
 * as postgresToolRegistry.ts/mysqlToolRegistry.ts. Deliberately a separate
 * registry from MySQL's, not a shared one keyed by "engine" — MariaDB and
 * MySQL are wire-compatible enough to share a connection tester, but
 * `mariadb-dump` and `mysqldump` are genuinely different tools (see
 * mariaDbDumpClient.ts's SSL_ARGS divergence), so their installed-version
 * inventories are independent facts about the machine.
 */
export function createMariaDbToolRegistry(settingsRepo: SettingsRepo): MariaDbToolRegistry {
  return {
    list() {
      return readAll(settingsRepo);
    },
    register(majorMinorVersion, paths) {
      const registry = readAll(settingsRepo);
      registry[majorMinorVersion] = paths;
      writeAll(settingsRepo, registry);
    },
    unregister(majorMinorVersion) {
      const registry = readAll(settingsRepo);
      delete registry[majorMinorVersion];
      writeAll(settingsRepo, registry);
    },
    resolve(serverVersion) {
      const registry = readAll(settingsRepo);
      return registry[extractMariaDbMajorMinorVersion(serverVersion)] ?? null;
    },
  };
}
