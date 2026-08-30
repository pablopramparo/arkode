#!/usr/bin/env node
// Vendors rclone.exe (single static binary, MIT-licensed -- confirmed
// permissive, no GPL concern) from rclone's official downloads into
// src-tauri/resources/rclone/, so a real install never needs RCLONE_PATH
// pointed at a manually-installed copy. rclone is what powers the off-site
// replication of backups to Google Drive (restic itself has no Drive
// backend; rclone is its documented bridge). Same shape as
// prepare-restic.mjs (download, verify, cache, vendor) -- rclone ships as a
// ~25MB zip with the exe nested one folder deep plus its LICENSE, which is
// also copied for compliance.
import extractZip from 'extract-zip';
import { createWriteStream, existsSync, mkdirSync, readdirSync, copyFileSync, rmSync, statSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const RCLONE_VERSION = '1.69.1';
const ZIP_URL = `https://downloads.rclone.org/v${RCLONE_VERSION}/rclone-v${RCLONE_VERSION}-windows-amd64.zip`;

const here = dirname(fileURLToPath(import.meta.url));
const desktopShellDir = join(here, '..');
const cacheDir = join(desktopShellDir, '.build-cache', `rclone-${RCLONE_VERSION}`);
const destDir = join(desktopShellDir, 'src-tauri', 'resources', 'rclone');
const cachedExePath = join(cacheDir, 'rclone.exe');
const cachedLicensePath = join(cacheDir, 'LICENSE');

/** Recursively find the first file matching `pred` under `dir`. */
function findFile(dir, pred) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = findFile(full, pred);
      if (hit) return hit;
    } else if (pred(entry.name)) {
      return full;
    }
  }
  return null;
}

async function ensureCache() {
  if (existsSync(cachedExePath)) {
    console.log(`Using cached rclone ${RCLONE_VERSION} at ${cachedExePath}`);
    return;
  }

  const zipPath = join(cacheDir, 'download.zip');
  mkdirSync(cacheDir, { recursive: true });

  // Real zip is ~25MB. Same "verify the byte count, don't trust a bare HTTP
  // 200" hardening as prepare-restic.mjs / prepare-pg-tools.mjs.
  const MIN_EXPECTED_BYTES = 15 * 1024 * 1024;
  const MAX_ATTEMPTS = 3;

  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    console.log(`Downloading rclone ${RCLONE_VERSION} for Windows... (attempt ${attempt}/${MAX_ATTEMPTS})`);
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
          `Downloaded file is only ${actualBytes} bytes, expected at least ${MIN_EXPECTED_BYTES} (~15MB) for the real rclone release zip.`,
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

  console.log('Extracting rclone.exe...');
  // extract-zip, not tar -- same reasoning as the other prepare-*.mjs scripts.
  const tempExtractDir = join(tmpdir(), `arkode-rclone-prep-${randomUUID()}`);
  mkdirSync(tempExtractDir, { recursive: true });
  try {
    await extractZip(zipPath, { dir: tempExtractDir });
    const extractedExe = findFile(tempExtractDir, (f) => f.toLowerCase() === 'rclone.exe');
    if (!extractedExe) throw new Error(`No rclone.exe found in the extracted rclone zip (looked in ${tempExtractDir}).`);
    const extractedLicense = findFile(tempExtractDir, (f) => f.toUpperCase() === 'LICENSE' || f.toUpperCase() === 'COPYING');
    mkdirSync(cacheDir, { recursive: true });
    // copyFileSync, not renameSync -- temp dir and .build-cache/ can be on different drives (EXDEV on Windows).
    copyFileSync(extractedExe, cachedExePath);
    if (extractedLicense) copyFileSync(extractedLicense, cachedLicensePath);
  } finally {
    rmSync(tempExtractDir, { recursive: true, force: true });
  }
  rmSync(zipPath, { force: true });
}

function vendorBinary() {
  rmSync(destDir, { recursive: true, force: true }); // never leave a stale binary from a previous version
  mkdirSync(destDir, { recursive: true });
  copyFileSync(cachedExePath, join(destDir, 'rclone.exe'));
  if (existsSync(cachedLicensePath)) copyFileSync(cachedLicensePath, join(destDir, 'LICENSE'));
  console.log(`Vendored rclone.exe (${RCLONE_VERSION}) into ${destDir}`);
}

await ensureCache();
vendorBinary();
