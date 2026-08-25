#!/usr/bin/env node
// Builds engine-cli.exe (via @yao-pkg/pkg) and copies it into src-tauri/binaries/
// under the exact name Tauri's `externalBin` sidecar convention requires:
// `<name>-<rust-host-triple>.exe`. Run automatically before `tauri build`
// (see tauri.conf.json's beforeBuildCommand) so a fresh build always bundles
// an up-to-date engine — not run before `tauri dev`, since dev mode never
// spawns the sidecar (see lib.rs's debug_assertions gate).
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const engineCliDir = join(repoRoot, 'packages', 'engine-cli');
const binariesDir = join(here, '..', 'src-tauri', 'binaries');

console.log('Building engine-cli.exe...');
execFileSync('pnpm', ['--filter', 'engine-cli', 'build'], { stdio: 'inherit', shell: true, cwd: repoRoot });
execFileSync('pnpm', ['--filter', 'engine-cli', 'build:exe'], { stdio: 'inherit', shell: true, cwd: repoRoot });

mkdirSync(binariesDir, { recursive: true });
const src = join(engineCliDir, 'dist-exe', 'engine-cli.exe');
// Hardcoded to this project's only current target — Windows x64 (matches
// rustc -vV's `host: x86_64-pc-windows-msvc` on every dev machine used for
// this app so far). Revisit if/when another target is actually built for.
const dest = join(binariesDir, 'engine-cli-x86_64-pc-windows-msvc.exe');
copyFileSync(src, dest);
console.log(`Sidecar ready: ${dest}`);
