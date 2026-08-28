import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveToolPath } from '../toolPaths.js';
import type { DumpValidator, ValidationResult } from './types.js';

const execFileAsync = promisify(execFile);

/**
 * Validates a PostgreSQL custom-format dump structurally via `pg_restore
 * --list`, rather than just trusting file existence/size. The binary path
 * comes from PG_RESTORE_PATH, or — on a real install, where a Scheduled
 * Task run has no env vars at all — the pg_restore.exe vendored next to
 * engine-cli.exe (see toolPaths.ts).
 */
export function createPostgresCustomValidator(
  pgRestorePath: string | undefined = resolveToolPath('PG_RESTORE_PATH', 'pg_restore.exe')
): DumpValidator {
  return {
    engine: 'postgres',
    async validate(localFilePath: string): Promise<ValidationResult> {
      if (!pgRestorePath) {
        const details = 'PG_RESTORE_PATH is not configured — cannot structurally validate the dump.';
        // Populated in both fields: `details` is what the orchestrator
        // surfaces as backup_runs.error_message on a Failed run, `warnings`
        // is what a future Warning-outcome UI would read — this is the only
        // failure branch here that was missing `details`, which meant a
        // Failed run recorded a generic "Validation failed." instead of the
        // actual reason.
        return { valid: false, warnings: [details], details };
      }

      try {
        const { stdout } = await execFileAsync(pgRestorePath, ['--list', localFilePath]);
        if (!stdout.trim()) {
          return { valid: false, warnings: [], details: 'pg_restore --list produced no output.' };
        }
        return { valid: true, warnings: [], details: `${stdout.trim().split('\n').length} entries listed.` };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { valid: false, warnings: [], details: `pg_restore --list failed: ${message}` };
      }
    },
  };
}
