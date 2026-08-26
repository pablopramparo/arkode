#!/usr/bin/env node
// Vendors restic.exe (single static binary, BSD-2-Clause — confirmed
// permissive, no GPL concern the way mysqldump/mariadb-dump have) from
// restic's own GitHub Releases into src-tauri/resources/restic/, so a real
// install never needs RESTIC_PATH pointed at a manually-installed copy —
// see CLAUDE.md's file-backup/"Packaging" notes. Same shape as
// prepare-pg-tools.mjs (download, verify, cache, vendor) since restic ships
// as one ~11MB zip rather than a full server distribution, there's no
// bin/-only filtering step needed here.
import extractZip from 'extract-zip';
import { createWriteStream, existsSync, mkdirSync, readdirSync, copyFileSync, rmSync, statSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const RESTIC_VERSION = '0.19.1';
const ZIP_URL = `https://github.com/restic/restic/releases/download/v${RESTIC_VERSION}/restic_${RESTIC_VERSION}_windows_amd64.zip`;

const here = dirname(fileURLToPath(import.meta.url));
const desktopShellDir = join(here, '..');
const cacheDir = join(desktopShellDir, '.build-cache', `restic-${RESTIC_VERSION}`);
const destDir = join(desktopShellDir, 'src-tauri', 'resources', 'restic');
const cachedExePath = join(cacheDir, 'restic.exe');

async function ensureCache() {
  if (existsSync(cachedExePath)) {
    console.log(`Using cached restic ${RESTIC_VERSION} at ${cachedExePath}`);
    return;
  }

  const zipPath = join(cacheDir, 'download.zip');
  mkdirSync(cacheDir, { recursive: true });

  // Real zip is ~11MB (confirmed by hand against a real download). Same
  // "verify the byte count, don't trust a bare HTTP 200" hardening as
  // prepare-pg-tools.mjs, for the same reason: a block/redirect page or a
  // truncated transfer would otherwise only surface as a cryptic failure
  // two steps later, inside extraction.
  const MIN_EXPECTED_BYTES = 8 * 1024 * 1024;
  const MAX_ATTEMPTS = 3;

  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    console.log(`Downloading restic ${RESTIC_VERSION} for Windows from GitHub Releases... (attempt ${attempt}/${MAX_ATTEMPTS})`);
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
          `Downloaded file is only ${actualBytes} bytes, expected at least ${MIN_EXPECTED_BYTES} (~8MB) for the real restic release zip. ` +
            `This usually means GitHub served something other than the real file, not a real restic binary.`,
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

  console.log('Extracting restic.exe...');
  // extract-zip, not tar — same reasoning as prepare-pg-tools.mjs: tar
  // resolves to genuinely different, mutually-incompatible implementations
  // depending on the shell (Git Bash's GNU tar vs. Windows' own bsdtar),
  // root-caused the hard way while building this app's other vendoring
  // scripts. extract-zip is deterministic regardless of host environment.
  const tempExtractDir = join(tmpdir(), `arkode-restic-prep-${randomUUID()}`);
  mkdirSync(tempExtractDir, { recursive: true });
  try {
    await extractZip(zipPath, { dir: tempExtractDir });
    // The zip contains exactly one file, restic_<version>_windows_amd64.exe
    // (confirmed by hand) — find it by extension rather than hardcoding the
    // exact name, so a version bump can't silently break this on a rename.
    const extractedExe = readdirSync(tempExtractDir).find((f) => f.toLowerCase().endsWith('.exe'));
    if (!extractedExe) throw new Error(`No .exe found in the extracted restic zip (looked in ${tempExtractDir}).`);
    mkdirSync(cacheDir, { recursive: true });
    // copyFileSync, not renameSync: the temp extraction dir and this
    // project's own .build-cache/ can live on different drives (confirmed
    // the hard way — os.tmpdir() defaults to the C: user-profile temp dir,
    // while this repo can be checked out on any drive), and a plain rename
    // across drives fails with EXDEV on Windows.
    copyFileSync(join(tempExtractDir, extractedExe), cachedExePath);
  } finally {
    rmSync(tempExtractDir, { recursive: true, force: true });
  }
  rmSync(zipPath, { force: true });
}

function vendorBinary() {
  rmSync(destDir, { recursive: true, force: true }); // never leave a stale binary from a previous version
  mkdirSync(destDir, { recursive: true });
  copyFileSync(cachedExePath, join(destDir, 'restic.exe'));
  console.log(`Vendored restic.exe (${RESTIC_VERSION}) into ${destDir}`);
}

await ensureCache();
vendorBinary();
