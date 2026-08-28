#!/usr/bin/env node
// Vendors MariaDB's `mariadb-dump.exe` and `mariadb.exe` (the client) into
// src-tauri/resources/mariadb/, so a real install can run a
// direct_dump backup of a MySQL *or* MariaDB server with ZERO
// configuration -- no separately-installed client, no MYSQLDUMP_PATH /
// MARIADB_DUMP_PATH / MYSQL_CLI_PATH env var, no tool-registry entry.
// engine-core resolves these relative to engine-cli.exe (see
// engine-core/src/toolPaths.ts), the same way it already does for the
// vendored Postgres tools.
//
// LICENSING: mariadb-dump / the mariadb client are GPLv2. arkode invokes
// them as a separate, unmodified process over a plain CLI boundary ("mere
// aggregation" -- arkode's own code stays non-GPL), and arkode is an
// internal tool operated by Codebius, not a redistributable product. The
// GPLv2 text and a pointer to the exact matching source tarball ship in
// LICENSES/ (bundled as an app resource). If the distribution model ever
// changes to end users self-installing, revisit that the written source
// offer is adequate.
//
// Same download/verify/cache/vendor shape as prepare-pg-tools.mjs /
// prepare-restic.mjs. mariadb-dump.exe is statically linked (confirmed by
// hand against a real install); the mariadb client can need a couple of
// OpenSSL DLLs for TLS connections, so a small curated DLL allowlist is
// copied alongside if present.
import extractZip from 'extract-zip';
import { createWriteStream, existsSync, mkdirSync, readdirSync, copyFileSync, rmSync, statSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

// LTS release. archive.mariadb.org keeps every version indefinitely, so a
// pinned exact version here is stable regardless of what mariadb.org's
// front page currently offers -- see CLAUDE.md's "auto-download" notes for
// why the exact version is always spelled out, never resolved by scraping.
const MARIADB_VERSION = '11.4.4';
const ZIP_URL = `https://archive.mariadb.org/mariadb-${MARIADB_VERSION}/winx64-packages/mariadb-${MARIADB_VERSION}-winx64.zip`;

const here = dirname(fileURLToPath(import.meta.url));
const desktopShellDir = join(here, '..');
const cacheDir = join(desktopShellDir, '.build-cache', `mariadb-${MARIADB_VERSION}`);
const cacheBinDir = join(cacheDir, 'bin');
const cachePluginDir = join(cacheDir, 'plugin');
const destDir = join(desktopShellDir, 'src-tauri', 'resources', 'mariadb');

const WANTED_EXES = ['mariadb-dump.exe', 'mariadb.exe'];
// Copied only if present in the zip's bin/ -- mariadb-dump is static, but
// the client can pull these for a TLS-secured connection.
const WANTED_DLL_PREFIXES = ['libcrypto', 'libssl', 'libcurl', 'zlib'];
// Client-side auth plugins from lib/plugin/. `caching_sha2_password.dll` is
// the important one: without it the MariaDB client CANNOT authenticate to a
// MySQL 8/9 server (whose default auth plugin it is) -- confirmed by hand
// against a real WAMP MySQL 9.1. Passed to the client/dumper via
// --plugin-dir (see mysqlClientResolution.ts).
const WANTED_PLUGINS = [
  'caching_sha2_password.dll',
  'sha256_password.dll',
  'client_ed25519.dll',
  'dialog.dll',
  'mysql_clear_password.dll',
];

async function ensureCache() {
  const cacheComplete =
    WANTED_EXES.every((name) => existsSync(join(cacheBinDir, name))) &&
    existsSync(join(cacheBinDir, 'COPYING')) &&
    existsSync(join(cachePluginDir, 'caching_sha2_password.dll'));
  if (cacheComplete) {
    console.log(`Using cached MariaDB ${MARIADB_VERSION} client tools at ${cacheBinDir}`);
    return;
  }

  const zipPath = join(cacheDir, 'download.zip');
  mkdirSync(cacheDir, { recursive: true });

  // Real zip is ~91MB (confirmed by hand against a real archive.mariadb.org
  // download). Verify the byte count rather than trusting a bare HTTP 200,
  // same reasoning as prepare-pg-tools.mjs: a redirect/block page or a
  // truncated transfer would otherwise only surface later, inside
  // extraction, as something cryptic.
  const MIN_EXPECTED_BYTES = 40 * 1024 * 1024;
  const MAX_ATTEMPTS = 3;

  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    console.log(`Downloading MariaDB ${MARIADB_VERSION} Windows package from archive.mariadb.org (~91MB, only two exes are kept)... (attempt ${attempt}/${MAX_ATTEMPTS})`);
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
          `Downloaded file is only ${actualBytes} bytes, expected at least ${MIN_EXPECTED_BYTES} (~40MB) for the real MariaDB winx64 zip. ` +
            `This usually means the archive served something other than the real file.`,
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

  console.log('Extracting MariaDB client tools...');
  // extract-zip, not system tar -- same reasoning as the other prepare-*
  // scripts (tar resolves to genuinely different, incompatible impls
  // depending on the shell; extract-zip is deterministic).
  const tempExtractDir = join(tmpdir(), `arkode-mariadb-prep-${randomUUID()}`);
  mkdirSync(tempExtractDir, { recursive: true });
  try {
    await extractZip(zipPath, { dir: tempExtractDir });
    // Zip root is `mariadb-<version>-winx64/`; tools live in its bin/.
    const rootEntry = readdirSync(tempExtractDir).find((f) => f.toLowerCase().startsWith('mariadb-'));
    if (!rootEntry) throw new Error(`No mariadb-* root dir found in the extracted zip (looked in ${tempExtractDir}).`);
    const extractedBin = join(tempExtractDir, rootEntry, 'bin');

    mkdirSync(cacheBinDir, { recursive: true });
    for (const name of WANTED_EXES) {
      const src = join(extractedBin, name);
      if (!existsSync(src)) throw new Error(`Expected ${name} in the MariaDB zip's bin/ but it wasn't there (${src}).`);
      // copyFileSync, not rename: temp dir and .build-cache/ can be on
      // different drives (EXDEV on Windows) -- same note as prepare-restic.
      copyFileSync(src, join(cacheBinDir, name));
    }
    // GPLv2 compliance: ship the exact license text that comes with these
    // binaries, straight from the upstream distribution rather than a
    // hand-copied version. MariaDB puts it at the zip root as COPYING.
    const zipRoot = join(tempExtractDir, rootEntry);
    for (const licenseName of ['COPYING', 'COPYING.thirdparty', 'THIRDPARTY.txt']) {
      const src = join(zipRoot, licenseName);
      if (existsSync(src)) copyFileSync(src, join(cacheBinDir, licenseName));
    }
    if (!existsSync(join(cacheBinDir, 'COPYING'))) {
      throw new Error(`Expected COPYING (the GPLv2 text) at the MariaDB zip root but it wasn't there (${zipRoot}).`);
    }
    for (const entry of readdirSync(extractedBin)) {
      const lower = entry.toLowerCase();
      if (lower.endsWith('.dll') && WANTED_DLL_PREFIXES.some((p) => lower.startsWith(p))) {
        copyFileSync(join(extractedBin, entry), join(cacheBinDir, entry));
      }
    }

    const extractedPluginDir = join(zipRoot, 'lib', 'plugin');
    mkdirSync(cachePluginDir, { recursive: true });
    for (const name of WANTED_PLUGINS) {
      const src = join(extractedPluginDir, name);
      if (existsSync(src)) copyFileSync(src, join(cachePluginDir, name));
    }
    if (!existsSync(join(cachePluginDir, 'caching_sha2_password.dll'))) {
      throw new Error(
        `Expected caching_sha2_password.dll in the MariaDB zip's lib/plugin/ but it wasn't there (${extractedPluginDir}).`
      );
    }
  } finally {
    rmSync(tempExtractDir, { recursive: true, force: true });
  }
  rmSync(zipPath, { force: true });
}

function vendorBinaries() {
  rmSync(destDir, { recursive: true, force: true }); // never leave stale files from a previous version
  mkdirSync(destDir, { recursive: true });
  mkdirSync(join(destDir, 'plugin'), { recursive: true });
  let count = 0;
  for (const entry of readdirSync(cacheBinDir)) {
    copyFileSync(join(cacheBinDir, entry), join(destDir, entry));
    count++;
  }
  for (const entry of readdirSync(cachePluginDir)) {
    copyFileSync(join(cachePluginDir, entry), join(destDir, 'plugin', entry));
    count++;
  }
  console.log(`Vendored ${count} MariaDB ${MARIADB_VERSION} file(s) into ${destDir}`);
}

await ensureCache();
vendorBinaries();
