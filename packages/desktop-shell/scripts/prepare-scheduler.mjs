#!/usr/bin/env node
// Builds the arkode-scheduler Windows service binary (src/bin/scheduler.rs)
// and copies it into src-tauri/resources/scheduler/ so `tauri build` bundles
// it and the installer lands it at
// `<install dir>\resources\scheduler\arkode-scheduler.exe`. Run automatically
// before `tauri build` (see tauri.conf.json's beforeBuildCommand) — the
// scheduler is a separate [[bin]] in the same crate, so `tauri build`'s own
// cargo invocation does not produce it.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const srcTauri = join(here, '..', 'src-tauri');
const outDir = join(srcTauri, 'resources', 'scheduler');
const dest = join(outDir, 'arkode-scheduler.exe');

// `cargo build` (below) runs the crate's build.rs = tauri-build, which
// validates tauri.conf.json's `bundle.resources` globs and *errors* if
// `resources/scheduler/*` matches nothing — but this script is what fills
// it. Drop a placeholder first so that validation passes; the real exe
// overwrites it right after.
mkdirSync(outDir, { recursive: true });
if (!existsSync(dest)) writeFileSync(dest, '');

console.log('Building arkode-scheduler.exe...');
execFileSync('cargo', ['build', '--release', '--bin', 'arkode-scheduler'], {
  stdio: 'inherit',
  shell: true,
  cwd: srcTauri,
});

const src = join(srcTauri, 'target', 'release', 'arkode-scheduler.exe');
copyFileSync(src, dest);
console.log(`Scheduler service ready: ${dest}`);
