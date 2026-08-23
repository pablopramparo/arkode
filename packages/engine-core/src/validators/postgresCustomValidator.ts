import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DumpValidator, ValidationResult } from './types.js';

const execFileAsync = promisify(execFile);

/**
 * Validates a PostgreSQL custom-format dump structurally via `pg_restore
 * --list`, rather than just trusting file existence/size. The binary path is
 * a dev-time env var for now (PG_RESTORE_PATH) — vendoring pg_restore.exe
 * into the installer is a packaging concern deferred until after the
 * vertical slice works, per the architecture plan (§2).
 */
export function createPostgresCustomValidator(pgRestorePath: string | undefined = process.env.PG_RESTORE_PATH): DumpValidator {
  return {
    engine: 'postgres',
    async validate(localFilePath: string): Promise<ValidationResult> {
      if (!pgRestorePath) {
        return {
          valid: false,
          warnings: ['PG_RESTORE_PATH is not configured — cannot structurally validate the dump.'],
        };
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
