import extractZip from 'extract-zip';
import { createWriteStream, mkdirSync, readdirSync, copyFileSync, rmSync, statSync, existsSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { PostgresToolPaths } from './postgresToolRegistry.js';
import type { MariaDbToolPaths } from './mariaDbToolRegistry.js';

/**
 * DBeaver-style "fetch the tool for me" auto-download — deliberately scoped
 * to postgres and mariadb only (see CLAUDE.md's "direct_dump tool version
 * management" note): both vendors publish versioned, permissively-licensed
 * client archives at stable, directly-downloadable URLs. MySQL is
 * deliberately excluded — Oracle's distribution isn't as scriptable, and
 * mysqldump's GPLv2 license already keeps it out of anything this app
 * downloads/bundles on the user's behalf (see the vendoring decision in
 * "Packaging"). Registering a downloaded tool still goes through the same
 * PostgresToolRegistry/MariaDbToolRegistry.register() the manual
 * pg-tools:register/mariadb-tools:register flow already uses — this module
 * only gets the binary onto disk, callers own registering it.
 *
 * Extraction uses the `extract-zip` npm package, not a shelled-out `tar` --
 * a real, hand-hit gotcha while building this (2026-08-25): `tar` resolves
 * to genuinely different implementations depending on the environment (GNU
 * tar under Git Bash/MSYS, bsdtar as Windows' own tar.exe), and they
 * disagree on both CLI argument ordering (bsdtar requires
 * --strip-components before -xf) *and* raw zip-format support (GNU tar
 * flatly can't read the real MariaDB release zip, bsdtar can). This module
 * runs at actual runtime on whatever a real client machine's PATH resolves
 * -- unlike prepare-pg-tools.mjs, a dev/build-time-only script where the
 * environment is controlled -- so depending on system `tar` here is a real
 * fragility risk, confirmed to actually bite, not just theorized.
 */
export type DownloadableEngine = 'postgres' | 'mariadb';

export interface DownloadToolInput {
  engine: DownloadableEngine;
  /**
   * The *exact*, fully-qualified version needed to build a real download
   * URL — e.g. "18.6-1" for postgres (EDB's own major.minor-buildrevision
   * scheme; the "-1" build suffix isn't guessable from the major version
   * alone, confirmed by hand against EDB's real download page), or
   * "11.5.2" for mariadb (major.minor.patch). Deliberately a separate,
   * explicit input from whatever major(.minor) version the caller will
   * register the result under — this module never tries to resolve
   * "latest" for a major version by scraping a vendor page, which would be
   * a real fragility risk against pages that aren't a stable, versioned
   * API; the caller (a human, via the CLI/UI) supplies the exact version
   * they want, same as they'd have typed into a browser.
   */
  exactVersion: string;
  /** Where to place the final vendored binaries — caller resolves via paths.vendoredToolsDir(engine, registryVersion). */
  destDir: string;
}

function buildDownloadUrl(engine: DownloadableEngine, exactVersion: string): string {
  if (engine === 'postgres') {
    return `https://get.enterprisedb.com/postgresql/postgresql-${exactVersion}-windows-x64-binaries.zip`;
  }
  return `https://archive.mariadb.org/mariadb-${exactVersion}/winx64-packages/mariadb-${exactVersion}-winx64.zip`;
}

// Real sizes as of 2026-08-25: the postgres zip (full server distribution,
// only bin/ is kept) is ~344MB; the mariadb zip (client+server bundle) is
// ~91MB. Floors set well under those, just high enough to reject a
// truncated transfer or an unexpected error/redirect page served instead
// of the real file — same reasoning and pattern as
// desktop-shell/scripts/prepare-pg-tools.mjs's own download hardening.
const MIN_EXPECTED_BYTES: Record<DownloadableEngine, number> = {
  postgres: 250 * 1024 * 1024,
  mariadb: 40 * 1024 * 1024,
};

async function downloadWithRetry(url: string, destPath: string, minExpectedBytes: number): Promise<void> {
  const MAX_ATTEMPTS = 3;
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok || !res.body) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
      await pipeline(res.body, createWriteStream(destPath));
      const actualBytes = statSync(destPath).size;
      if (actualBytes < minExpectedBytes) {
        throw new Error(
          `Downloaded file is only ${actualBytes} bytes, expected at least ${minExpectedBytes} — this usually means the version string doesn't match a real published release, or something other than the real file was served.`
        );
      }
      return;
    } catch (err) {
      lastError = err;
      rmSync(destPath, { force: true });
    }
  }
  throw lastError;
}

// EDB's bin/ also ships wxWidgets DLLs (StackBuilder, never used here) and
// a leftover testplug.dll — same exclusion list as prepare-pg-tools.mjs,
// confirmed there (2026-08-24) that pg_dump/pg_restore/psql run fine
// without any of them.
const EXCLUDE_PREFIXES = ['wx'];
const EXCLUDE_EXACT = new Set(['testplug.dll']);

async function extractPostgres(zipPath: string, destDir: string): Promise<PostgresToolPaths & { psqlPath: string }> {
  const tempExtractDir = join(tmpdir(), `arkode-pgtools-${randomUUID()}`);
  mkdirSync(tempExtractDir, { recursive: true });
  try {
    // extract-zip has no partial-extraction/pattern support, so this pulls
    // the entire ~344MB server distribution into a temp dir even though
    // only bin/ is kept -- heavier than a selective `tar` extraction would
    // be, but reliable regardless of the host environment (see the module
    // doc comment). Cleaned up in the finally block either way.
    await extractZip(zipPath, { dir: tempExtractDir });

    const binDir = join(tempExtractDir, 'pgsql', 'bin');
    rmSync(destDir, { recursive: true, force: true });
    mkdirSync(destDir, { recursive: true });
    const wanted = readdirSync(binDir).filter((f) => {
      const lower = f.toLowerCase();
      const isRelevant = lower.endsWith('.dll') || lower === 'pg_dump.exe' || lower === 'pg_restore.exe' || lower === 'psql.exe';
      if (!isRelevant) return false;
      if (EXCLUDE_EXACT.has(lower)) return false;
      if (EXCLUDE_PREFIXES.some((prefix) => lower.startsWith(prefix))) return false;
      return true;
    });
    for (const file of wanted) {
      copyFileSync(join(binDir, file), join(destDir, file));
    }
  } finally {
    rmSync(tempExtractDir, { recursive: true, force: true });
  }

  const pgDumpPath = join(destDir, 'pg_dump.exe');
  const pgRestorePath = join(destDir, 'pg_restore.exe');
  const psqlPath = join(destDir, 'psql.exe');
  if (!existsSync(pgDumpPath) || !existsSync(pgRestorePath) || !existsSync(psqlPath)) {
    throw new Error('Extraction completed but pg_dump.exe/pg_restore.exe/psql.exe were not all found in the downloaded archive.');
  }
  return { pgDumpPath, pgRestorePath, psqlPath };
}

async function extractMariaDb(zipPath: string, destDir: string, exactVersion: string): Promise<MariaDbToolPaths> {
  const tempExtractDir = join(tmpdir(), `arkode-mariadbtools-${randomUUID()}`);
  mkdirSync(tempExtractDir, { recursive: true });
  try {
    await extractZip(zipPath, { dir: tempExtractDir });

    // mariadb-dump.exe is statically linked -- confirmed by hand
    // (2026-08-25) that an isolated single-file copy (no DLLs alongside
    // it) runs standalone (`mariadb-dump.exe --version` succeeded from an
    // empty folder), unlike postgres's libpq-based tools.
    const sourcePath = join(tempExtractDir, `mariadb-${exactVersion}-winx64`, 'bin', 'mariadb-dump.exe');
    if (!existsSync(sourcePath)) {
      throw new Error(`Expected ${sourcePath} inside the downloaded archive, but it wasn't there.`);
    }
    mkdirSync(destDir, { recursive: true });
    copyFileSync(sourcePath, join(destDir, 'mariadb-dump.exe'));
  } finally {
    rmSync(tempExtractDir, { recursive: true, force: true });
  }

  return { mariaDbDumpPath: join(destDir, 'mariadb-dump.exe') };
}

export async function downloadTool(input: DownloadToolInput): Promise<PostgresToolPaths | MariaDbToolPaths> {
  const url = buildDownloadUrl(input.engine, input.exactVersion);
  const zipPath = join(tmpdir(), `arkode-tool-download-${randomUUID()}.zip`);
  try {
    await downloadWithRetry(url, zipPath, MIN_EXPECTED_BYTES[input.engine]);
    return input.engine === 'postgres'
      ? await extractPostgres(zipPath, input.destDir)
      : await extractMariaDb(zipPath, input.destDir, input.exactVersion);
  } finally {
    rmSync(zipPath, { force: true });
  }
}
