import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * External tool binaries the installer vendors *next to* engine-cli.exe,
 * under `<installDir>/resources/...` — see desktop-shell's
 * prepare-pg-tools.mjs / prepare-restic.mjs and CLAUDE.md's "Packaging"
 * section.
 *
 * The Tauri sidecar spawn sets PG_DUMP_PATH / PG_RESTORE_PATH / PSQL_PATH /
 * RESTIC_PATH as env vars explicitly (lib.rs), so the *app's own* runs have
 * always found these. A Windows Scheduled Task invoking `engine-cli.exe
 * run-due` does not: Task Scheduler v2 Exec actions carry no environment at
 * all, and there is no per-user env for the SYSTEM account this app's tasks
 * run as. So a scheduled Postgres backup would download its dump fine and
 * then fail validation with "PG_RESTORE_PATH is not configured" — which is
 * exactly what happened in production.
 *
 * The fix: engine-cli finds its own vendored tools relative to its own
 * location, the same way lib.rs resolves them relative to the install's
 * Resource dir. Installed layout:
 *
 *   C:\Program Files\arkode\engine-cli.exe            <- process.execPath
 *   C:\Program Files\arkode\resources\pgsql\bin\pg_restore.exe
 *   C:\Program Files\arkode\resources\restic\restic.exe
 *
 * In dev (`node dist/index.js`) process.execPath is node.exe with no
 * sibling `resources/` dir, so every lookup here misses and the caller
 * falls back to its env-var default exactly as before. An explicitly-set
 * env var always wins over the vendored copy (they point at the same file
 * on a real install anyway).
 *
 * mysqldump / mariadb-dump are deliberately NOT vendored (GPLv2 — a real,
 * confirmed decision, see CLAUDE.md), so there is no bundled fallback for
 * them: those stay env-var / tool-registry only.
 */
const BUNDLED_RELATIVE_PATH: Record<string, string> = {
  'pg_dump.exe': 'resources/pgsql/bin/pg_dump.exe',
  'pg_restore.exe': 'resources/pgsql/bin/pg_restore.exe',
  'psql.exe': 'resources/pgsql/bin/psql.exe',
  'restic.exe': 'resources/restic/restic.exe',
  // rclone — off-site replication of backups to Google Drive. MIT-licensed,
  // single static binary, vendored like restic. See prepare-rclone.mjs.
  'rclone.exe': 'resources/rclone/rclone.exe',
  // MariaDB's dumper + client, GPLv2 (see LICENSES/NOTICE.md). Bundled so a
  // direct_dump of a MySQL *or* MariaDB server needs zero configuration —
  // mariadb-dump / mariadb speak the MySQL wire protocol. Oracle's own
  // mysqldump/mysql are deliberately NOT bundled (also GPLv2, but arkode
  // ships one family, not both).
  'mariadb-dump.exe': 'resources/mariadb/mariadb-dump.exe',
  'mariadb.exe': 'resources/mariadb/mariadb.exe',
};

/**
 * Absolute path to a tool vendored next to the running executable, or
 * undefined if this build has no such sibling file (dev, tests, or a tool
 * that isn't vendored at all).
 */
export function resolveBundledToolPath(toolExeName: string): string | undefined {
  const relative = BUNDLED_RELATIVE_PATH[toolExeName];
  if (!relative) return undefined;
  const candidate = join(dirname(process.execPath), ...relative.split('/'));
  return existsSync(candidate) ? candidate : undefined;
}

/**
 * Effective path for an external tool: an explicitly-set env var if present
 * (and non-blank), otherwise the copy vendored next to engine-cli.exe,
 * otherwise undefined (caller handles "not available").
 */
export function resolveToolPath(envVarName: string, toolExeName: string): string | undefined {
  const fromEnv = process.env[envVarName];
  if (fromEnv && fromEnv.trim() !== '') return fromEnv;
  return resolveBundledToolPath(toolExeName);
}
