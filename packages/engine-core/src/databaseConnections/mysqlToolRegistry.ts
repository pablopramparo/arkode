import type { SettingsRepo } from '../db/repositories/settingsRepo.js';

export interface MysqlToolPaths {
  mysqldumpPath: string;
}

const SETTINGS_KEY = 'mysqlToolRegistry';

export interface MysqlToolRegistry {
  /** Every registered entry, keyed by major.minor version (e.g. "8.0", "9.1"). */
  list(): Record<string, MysqlToolPaths>;
  /** Registers (or replaces) the mysqldump path for a given major.minor version. */
  register(majorMinorVersion: string, paths: MysqlToolPaths): void;
  /** Removes a registered major.minor version, if present — a no-op otherwise. */
  unregister(majorMinorVersion: string): void;
  /** Looks up the entry matching a detected server version string (e.g. "9.1.0"). Returns null if nothing is registered for that major.minor version — callers should fall back to a single default path in that case. */
  resolve(serverVersion: string): MysqlToolPaths | null;
}

/**
 * MySQL versions its release series as major.minor (8.0, 8.4, 9.1, ...) —
 * each series is Oracle's own compatibility/support boundary, unlike
 * PostgreSQL where only the single leading number matters from v10 on. So
 * "9.1.0" needs "9.1" as its registry key, not just "9".
 */
export function extractMysqlMajorMinorVersion(serverVersion: string): string {
  const match = serverVersion.match(/^(\d+)\.(\d+)/);
  return match ? `${match[1]}.${match[2]}` : serverVersion;
}

function readAll(settingsRepo: SettingsRepo): Record<string, MysqlToolPaths> {
  const raw = settingsRepo.get(SETTINGS_KEY);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, MysqlToolPaths>;
  } catch {
    return {};
  }
}

function writeAll(settingsRepo: SettingsRepo, registry: Record<string, MysqlToolPaths>): void {
  settingsRepo.set(SETTINGS_KEY, JSON.stringify(registry));
}

/**
 * A registry of mysqldump paths keyed by MySQL major.minor version, backed
 * by the existing `app_settings` key-value table — the same pattern as
 * postgresToolRegistry.ts. Kept as its own file rather than a shared generic
 * factory: the value shape (one path here vs. postgres's dump+restore pair)
 * and the version-key scheme (major.minor here vs. postgres's single-number-
 * from-10-on) both genuinely differ per engine.
 */
export function createMysqlToolRegistry(settingsRepo: SettingsRepo): MysqlToolRegistry {
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
      return registry[extractMysqlMajorMinorVersion(serverVersion)] ?? null;
    },
  };
}
