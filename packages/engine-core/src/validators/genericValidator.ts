import { stat } from 'node:fs/promises';
import type { DumpValidator, ValidationResult } from './types.js';

/**
 * Minimum bar the spec requires for every dump regardless of engine: it
 * exists and it isn't empty. Checksum presence is enforced by the
 * orchestrator (it always populates backup_runs.checksum_sha256 before this
 * runs), not re-verified here.
 */
export function createGenericValidator(): DumpValidator {
  return {
    engine: 'generic',
    async validate(localFilePath: string): Promise<ValidationResult> {
      const warnings: string[] = [];
      let fileStat;
      try {
        fileStat = await stat(localFilePath);
      } catch {
        return { valid: false, warnings, details: `File does not exist: ${localFilePath}` };
      }

      if (fileStat.size <= 0) {
        return { valid: false, warnings, details: 'File exists but is empty (size <= 0).' };
      }

      return { valid: true, warnings };
    },
  };
}
