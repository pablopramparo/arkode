import type { SettingsRepo } from '../db/repositories/settingsRepo.js';

export interface PostgresToolPaths {
  pgDumpPath: string;
  pgRestorePath: string;
}

const SETTINGS_KEY = 'postgresToolRegistry';

export interface PostgresToolRegistry {
  /** Every registered entry, keyed by major version (e.g. "15", "18", or "9.6" for pre-10 versions). */
  list(): Record<string, PostgresToolPaths>;
  /** Registers (or replaces) the tool paths for a given major version. */
  register(majorVersion: string, paths: PostgresToolPaths): void;
  /** Removes a registered major version, if present — a no-op otherwise. */
  unregister(majorVersion: string): void;
  /** Looks up the entry matching a detected server version string (e.g. "18.0"). Returns null if nothing is registered for that major version — callers should fall back to a single default path in that case. */
  resolve(serverVersion: string): PostgresToolPaths | null;
}

/**
 * PostgreSQL versioned its major releases as X.Y through 9.6 (9.4, 9.5, 9.6),
 * then switched to a single number from 10 onward (10, 11, ..., 18). "9.6.3"
 * needs "9.6" as its major version; "18.0" needs "18". Every version this
 * app is realistically used against is 10+, but the distinction costs
 * nothing to get right.
 */
export function extractMajorVersion(serverVersion: string): string {
  const match = serverVersion.match(/^(\d+)(?:\.(\d+))?/);
  if (!match) return serverVersion;
  const [, first, second] = match;
  return first === '9' && second ? `${first}.${second}` : first;
}

function readAll(settingsRepo: SettingsRepo): Record<string, PostgresToolPaths> {
  const raw = settingsRepo.get(SETTINGS_KEY);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, PostgresToolPaths>;
  } catch {
    return {};
  }
}

function writeAll(settingsRepo: SettingsRepo, registry: Record<string, PostgresToolPaths>): void {
  settingsRepo.set(SETTINGS_KEY, JSON.stringify(registry));
}

/**
 * A registry of pg_dump/pg_restore paths keyed by PostgreSQL major version,
 * backed by the existing `app_settings` key-value table (one JSON blob under
 * a fixed key — no schema change needed, as anticipated in CLAUDE.md's
 * "direct_dump tool version management" note). Lets `postgresDumpClient.ts`
 * pick a version-appropriate tool instead of always using one fixed
 * PG_DUMP_PATH — an empty registry (the default, until entries are
 * explicitly added via `pg-tools:register`) changes nothing about today's
 * single-path behavior.
 */
export function createPostgresToolRegistry(settingsRepo: SettingsRepo): PostgresToolRegistry {
  return {
    list() {
      return readAll(settingsRepo);
    },
    register(majorVersion, paths) {
      const registry = readAll(settingsRepo);
      registry[majorVersion] = paths;
      writeAll(settingsRepo, registry);
    },
    unregister(majorVersion) {
      const registry = readAll(settingsRepo);
      delete registry[majorVersion];
      writeAll(settingsRepo, registry);
    },
    resolve(serverVersion) {
      const registry = readAll(settingsRepo);
      return registry[extractMajorVersion(serverVersion)] ?? null;
    },
  };
}
