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
import { execFileSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readdirSync, copyFileSync, rmSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

  console.log(`Downloading PostgreSQL ${PG_VERSION} Windows binaries from EDB (~344MB, only bin/ is kept)...`);
  const zipPath = join(cacheDir, 'download.zip');
  mkdirSync(cacheDir, { recursive: true });

  const res = await fetch(ZIP_URL);
  if (!res.ok || !res.body) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  await pipeline(res.body, createWriteStream(zipPath));

  console.log('Extracting bin/ (pg_dump, pg_restore, psql, and their DLLs)...');
  mkdirSync(cacheBinDir, { recursive: true });
  // tar (bundled with Windows 10+ and Git Bash) reads zip via bsdtar under the hood on Windows.
  execFileSync('tar', ['-xf', zipPath, '-C', cacheDir, 'pgsql/bin', '--strip-components=1'], { stdio: 'inherit' });
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
