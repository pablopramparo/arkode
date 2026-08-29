#!/usr/bin/env node
// Builds the arkode-scheduler Windows service binary (src/bin/scheduler.rs)
// and copies it into src-tauri/resources/scheduler/ so `tauri build` bundles
// it and the installer lands it at
// `<install dir>\resources\scheduler\arkode-scheduler.exe`. Run automatically
// before `tauri build` (see tauri.conf.json's beforeBuildCommand) — the
// scheduler is a separate [[bin]] in the same crate, so `tauri build`'s own
// cargo invocation does not produce it.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const srcTauri = join(here, '..', 'src-tauri');
const outDir = join(srcTauri, 'resources', 'scheduler');

console.log('Building arkode-scheduler.exe...');
execFileSync('cargo', ['build', '--release', '--bin', 'arkode-scheduler'], {
  stdio: 'inherit',
  shell: true,
  cwd: srcTauri,
});

mkdirSync(outDir, { recursive: true });
const src = join(srcTauri, 'target', 'release', 'arkode-scheduler.exe');
const dest = join(outDir, 'arkode-scheduler.exe');
copyFileSync(src, dest);
console.log(`Scheduler service ready: ${dest}`);
