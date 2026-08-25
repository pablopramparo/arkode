#!/usr/bin/env node
// Vendors pg_dump.exe/pg_restore.exe/psql.exe (+ every DLL they and libpq
// depend on) from EnterpriseDB's official Windows x64 "binaries" zip into
// src-tauri/resources/pgsql/bin/, so a real install never needs
// PG_DUMP_PATH/PG_RESTORE_PATH/PSQL_PATH pointed at a manually-installed
// PostgreSQL — see CLAUDE.md's "Packaging" section. Deliberately Postgres
// only: mysqldump/mariadb-dump are GPLv2 and, per an explicit 2026-08-24
// decision, are NOT vendored — those stay a manual per-machine install.
//
// The full EDB zip is ~344MB (it's the entire server distribution); only
// bin/*.exe and bin/*.dll are ever extracted from it. The extracted result
// is cached locally (.build-cache/, gitignored) so re-running this script
// doesn't re-download 344MB every time — only the first run, or after
// bumping PG_VERSION below, touches the network.
import extractZip from 'extract-zip';
import { createWriteStream, existsSync, mkdirSync, readdirSync, copyFileSync, rmSync, statSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const PG_VERSION = '18.6-1';
const ZIP_URL = `https://get.enterprisedb.com/postgresql/postgresql-${PG_VERSION}-windows-x64-binaries.zip`;

const here = dirname(fileURLToPath(import.meta.url));
const desktopShellDir = join(here, '..');
const cacheDir = join(desktopShellDir, '.build-cache', `pgsql-${PG_VERSION}`);
const cacheBinDir = join(cacheDir, 'bin');
const destDir = join(desktopShellDir, 'src-tauri', 'resources', 'pgsql', 'bin');

async function ensureCache() {
  if (existsSync(cacheBinDir) && readdirSync(cacheBinDir).some((f) => f.toLowerCase() === 'pg_dump.exe')) {
    console.log(`Using cached PostgreSQL ${PG_VERSION} client tools at ${cacheBinDir}`);
    return;
  }

  const zipPath = join(cacheDir, 'download.zip');
  mkdirSync(cacheDir, { recursive: true });

  // The real zip is ~344MB. A response well under that (an anti-bot/CDN
  // block page, a redirect EDB serves for datacenter/cloud-runner IP ranges,
  // a transient truncated transfer, etc.) still comes back as an HTTP 200
  // with a body — silently writing that out and only failing two steps
  // later inside extraction (a cryptic error) is exactly what happened on
  // this pipeline's first real CI run. Checking the actual byte count
  // against a sane floor here fails fast with a diagnosable reason
  // instead. A couple of retries covers a one-off transient blip; a real
  // block/redirect will fail the same way every time and surface clearly
  // rather than after several minutes.
  const MIN_EXPECTED_BYTES = 250 * 1024 * 1024; // real zip is ~344MB; well under that means something's wrong
  const MAX_ATTEMPTS = 3;

  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    console.log(`Downloading PostgreSQL ${PG_VERSION} Windows binaries from EDB (~344MB, only bin/ is kept)... (attempt ${attempt}/${MAX_ATTEMPTS})`);
    try {
      const res = await fetch(ZIP_URL);
      const contentLength = res.headers.get('content-length');
      console.log(`  HTTP ${res.status} ${res.statusText}, content-type=${res.headers.get('content-type')}, content-length=${contentLength ?? 'unknown'}`);
      if (!res.ok || !res.body) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
      await pipeline(res.body, createWriteStream(zipPath));

      const actualBytes = statSync(zipPath).size;
      console.log(`  Downloaded ${actualBytes} bytes.`);
      if (actualBytes < MIN_EXPECTED_BYTES) {
        throw new Error(
          `Downloaded file is only ${actualBytes} bytes, expected at least ${MIN_EXPECTED_BYTES} (~250MB) for the real EDB zip. ` +
            `This usually means EDB served something other than the real file (a block/redirect page for this network, a transient truncated transfer, etc.), not a real PostgreSQL distribution.`,
        );
      }
      lastError = undefined;
      break;
    } catch (err) {
      lastError = err;
      rmSync(zipPath, { force: true });
      console.error(`  Attempt ${attempt} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (lastError) throw lastError;

  console.log('Extracting bin/ (pg_dump, pg_restore, psql, and their DLLs)...');
  // Not `tar`: root-caused 2026-08-25 (see CLAUDE.md's "Packaging" note)
  // that `tar` on PATH resolves to genuinely different implementations
  // depending on the shell -- GNU tar (Git Bash/MSYS, what every local
  // dev-machine test goes through) versus bsdtar (Windows' own tar.exe,
  // what the GitHub Actions runner's PowerShell resolves) -- and they
  // disagree on CLI argument ordering, `--force-local` support, and even
  // raw zip-format support (confirmed separately for a different zip while
  // building the auto-download feature). Rather than keep chasing
  // per-runner tar quirks, this uses the same `extract-zip` npm package
  // downloadTool.ts uses for its own runtime extraction -- deterministic
  // regardless of the host environment. extract-zip has no
  // partial-extraction support, so this pulls the entire ~344MB
  // distribution into a throwaway temp dir even though only bin/ is kept;
  // heavier than a selective tar extraction would be, but reliable, and
  // the temp dir is deleted immediately after.
  const tempExtractDir = join(tmpdir(), `arkode-pgtools-prep-${randomUUID()}`);
  mkdirSync(tempExtractDir, { recursive: true });
  try {
    await extractZip(zipPath, { dir: tempExtractDir });
    mkdirSync(cacheBinDir, { recursive: true });
    const sourceBinDir = join(tempExtractDir, 'pgsql', 'bin');
    for (const file of readdirSync(sourceBinDir)) {
      copyFileSync(join(sourceBinDir, file), join(cacheBinDir, file));
    }
  } finally {
    rmSync(tempExtractDir, { recursive: true, force: true });
  }
  rmSync(zipPath, { force: true });
}

// EDB's bin/ also ships wxWidgets DLLs (for StackBuilder, a GUI installer
// tool we never use) and a leftover testplug.dll — confirmed by hand
// (2026-08-24) that pg_dump/pg_restore/psql run fine without any of them,
// copied alone into an isolated folder with the rest of bin/'s DLLs. Saves
// ~13MB that would otherwise ship in the installer for nothing.
const EXCLUDE_PREFIXES = ['wx'];
const EXCLUDE_EXACT = new Set(['testplug.dll']);

function vendorBinaries() {
  rmSync(destDir, { recursive: true, force: true }); // never leave stale files from a previous version/filter
  mkdirSync(destDir, { recursive: true });
  const wanted = readdirSync(cacheBinDir).filter((f) => {
    const lower = f.toLowerCase();
    const isRelevant = lower.endsWith('.dll') || lower === 'pg_dump.exe' || lower === 'pg_restore.exe' || lower === 'psql.exe';
    if (!isRelevant) return false;
    if (EXCLUDE_EXACT.has(lower)) return false;
    if (EXCLUDE_PREFIXES.some((prefix) => lower.startsWith(prefix))) return false;
    return true;
  });
  for (const file of wanted) {
    copyFileSync(join(cacheBinDir, file), join(destDir, file));
  }
  console.log(`Vendored ${wanted.length} files into ${destDir}`);
}

await ensureCache();
vendorBinaries();
