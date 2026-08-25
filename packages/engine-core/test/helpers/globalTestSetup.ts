import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Runs before every test file. Without this, any test that doesn't
// explicitly override CODEBIUS_APP_DATA_DIR falls through to
// paths.appDataDir()'s real PROGRAMDATA-based default — on a real Windows
// dev machine that silently resolves to the actual production app-data
// directory (a real bug hit and fixed 2026-08-25: an eagerly-resolved
// paths.keysDir() in importConfig.ts), and on any non-Windows CI runner
// (PROGRAMDATA doesn't exist) it throws outright. One real, isolated temp
// directory per test file closes both gaps at the source, rather than
// chasing each call site that forgets to override it.
if (!process.env.CODEBIUS_APP_DATA_DIR) {
  process.env.CODEBIUS_APP_DATA_DIR = mkdtempSync(join(tmpdir(), 'arkode-test-appdata-'));
}
