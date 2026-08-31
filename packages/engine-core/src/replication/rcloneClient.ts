import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveToolPath } from '../toolPaths.js';
import { buildRcloneConfigIni, rcloneRemoteSection } from './rcloneConfig.js';
import type { RcloneDriveConfig, RcloneSyncResult, ReplicationTarget } from './types.js';

const execFileAsync = promisify(execFile);

/**
 * RCLONE_PATH when set (dev, and the Tauri sidecar which sets it
 * explicitly), otherwise the rclone.exe vendored next to engine-cli.exe on
 * a real install — same fallback pattern as restic / the Postgres tools, so
 * a scheduler-service tick (which inherits no env) can still find it. See
 * toolPaths.ts.
 */
export function resolveRclonePath(): string {
  const configured = resolveToolPath('RCLONE_PATH', 'rclone.exe');
  if (!configured) {
    throw new Error(
      'RCLONE_PATH is not configured and no vendored rclone.exe was found next to engine-cli.exe — cannot run rclone.'
    );
  }
  return configured;
}

interface ExecErrorWithOutput {
  stdout?: string;
  stderr?: string;
  message?: string;
}

function rcloneErrorMessage(err: unknown, op: string): string {
  const e = err as ExecErrorWithOutput;
  const stderr = (e?.stderr ?? '').trim();
  // rclone's most useful line is usually the last non-empty stderr line.
  const lastLine = stderr.split(/\r?\n/).filter(Boolean).pop();
  return `rclone ${op} failed: ${lastLine || e?.message || 'unknown error'}`;
}

export async function rcloneVersion(): Promise<string> {
  const { stdout } = await execFileAsync(resolveRclonePath(), ['version'], { windowsHide: true });
  return stdout.split(/\r?\n/)[0]?.trim() ?? stdout.trim();
}

/** rclone-"obscures" a plaintext password (reversible scramble rclone.conf requires). */
export async function rcloneObscure(plaintext: string): Promise<string> {
  const { stdout } = await execFileAsync(resolveRclonePath(), ['obscure', plaintext], { windowsHide: true });
  return stdout.trim();
}

export interface RcloneSecrets {
  drive: RcloneDriveConfig;
  /** Plaintext crypt password — obscured here before it touches the config file. */
  cryptPassword?: string;
}

/**
 * Writes a locked-down temp rclone.conf for `target`, invokes `fn` with its
 * path and the remote section to address, then deletes it (even on throw).
 */
export async function withRcloneConfig<T>(
  target: Pick<ReplicationTarget, 'encryptWithCrypt'>,
  secrets: RcloneSecrets,
  fn: (configPath: string, remoteSection: string) => Promise<T>
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'arkode-rclone-'));
  const configPath = join(dir, 'rclone.conf');
  try {
    const obscuredCryptPassword = target.encryptWithCrypt
      ? await rcloneObscure(requireCryptPassword(secrets))
      : undefined;
    const ini = buildRcloneConfigIni({
      drive: secrets.drive,
      withCrypt: target.encryptWithCrypt,
      obscuredCryptPassword,
    });
    await writeFile(configPath, ini, { mode: 0o600 });
    await chmod(configPath, 0o600).catch(() => {});
    return await fn(configPath, rcloneRemoteSection(target));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function requireCryptPassword(secrets: RcloneSecrets): string {
  if (!secrets.cryptPassword) {
    throw new Error('This replication target is encrypted but no crypt password was provided.');
  }
  return secrets.cryptPassword;
}

interface RcloneStatsLine {
  bytes?: number;
  transfers?: number;
  deletes?: number;
  errors?: number;
}

function parseSyncStats(stderr: string): { stats: RcloneStatsLine; warnings: string[] } {
  let stats: RcloneStatsLine = {};
  const warnings: string[] = [];
  for (const line of stderr.split(/\r?\n/)) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const obj = JSON.parse(line) as { stats?: RcloneStatsLine; level?: string; msg?: string };
      if (obj.stats) stats = obj.stats;
      if (obj.level === 'warning' && obj.msg) warnings.push(obj.msg);
    } catch {
      /* not a JSON log line */
    }
  }
  return { stats, warnings };
}

export interface RcloneSyncOptions {
  configPath: string;
  remoteSection: string;
  /** Local absolute source directory. */
  source: string;
  /** Destination folder inside the remote (target.remotePath). */
  remotePath: string;
  /** Remote folder that files deleted on the destination are moved into instead of being destroyed. */
  backupDir?: string;
  /** Extra rclone args, e.g. --exclude patterns for the db_dumps content kind. */
  extraArgs?: string[];
}

/**
 * `rclone sync <source> <remoteSection>:<remotePath>` — mirrors the local
 * folder to the remote (propagates deletions, guarded by `backupDir`).
 * Returns the transfer summary parsed from rclone's JSON log.
 */
export async function rcloneSync(opts: RcloneSyncOptions): Promise<RcloneSyncResult> {
  const args = [
    'sync',
    opts.source,
    `${opts.remoteSection}:${opts.remotePath}`,
    '--config',
    opts.configPath,
    '--transfers',
    '4',
    '--checkers',
    '8',
    '--fast-list',
    '--use-json-log',
    '--stats-log-level',
    'NOTICE',
    '--stats',
    '10s',
  ];
  if (opts.backupDir) args.push('--backup-dir', opts.backupDir);
  if (opts.extraArgs) args.push(...opts.extraArgs);

  let stderr = '';
  try {
    ({ stderr } = await execFileAsync(resolveRclonePath(), args, {
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    }));
  } catch (err) {
    // Attach whatever stats rclone did emit before failing, then rethrow a clean message.
    throw new Error(rcloneErrorMessage(err, 'sync'));
  }
  const { stats, warnings } = parseSyncStats(stderr);
  return {
    bytesTransferred: stats.bytes ?? 0,
    filesTransferred: stats.transfers ?? 0,
    filesDeleted: stats.deletes ?? 0,
    warnings,
  };
}

/** `rclone copy <remoteSection>:<remotePath> <destDir>` — for disaster recovery (pull the remote copy back). */
export async function rcloneCopyDown(opts: {
  configPath: string;
  remoteSection: string;
  remotePath: string;
  destDir: string;
}): Promise<void> {
  const args = [
    'copy',
    `${opts.remoteSection}:${opts.remotePath}`,
    opts.destDir,
    '--config',
    opts.configPath,
    '--transfers',
    '4',
    '--checkers',
    '8',
    '--fast-list',
  ];
  try {
    await execFileAsync(resolveRclonePath(), args, { windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    throw new Error(rcloneErrorMessage(err, 'copy'));
  }
}

/** `rclone about <remoteSection>:` — a cheap connectivity + auth check that returns the account's quota. */
export async function rcloneAbout(opts: { configPath: string; remoteSection: string }): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      resolveRclonePath(),
      ['about', `${opts.remoteSection}:`, '--config', opts.configPath],
      { windowsHide: true }
    );
    return stdout.trim();
  } catch (err) {
    throw new Error(rcloneErrorMessage(err, 'about'));
  }
}

/**
 * Runs `rclone authorize "drive"`, which drives the Google consent flow and
 * blocks until the user approves, then prints the OAuth token blob. Returns
 * that token JSON string (to be stored in SecretStore as part of the
 * target's RcloneDriveConfig).
 *
 * `clientId`/`clientSecret`, when supplied, authorize against the
 * operator's own Google OAuth app instead of rclone's shared one.
 *
 * `noOpenBrowser` passes `--auth-no-open-browser`: rclone opens nothing and
 * just prints the local consent URL, for the user to open in whatever
 * browser they want (on this same machine — the callback listener is on
 * 127.0.0.1). `onAuthUrl` is called once with that URL as soon as rclone
 * prints it.
 */
export async function rcloneAuthorizeDrive(opts?: {
  clientId?: string;
  clientSecret?: string;
  timeoutMs?: number;
  noOpenBrowser?: boolean;
  onAuthUrl?: (url: string) => void;
}): Promise<string> {
  const args = ['authorize', 'drive'];
  if (opts?.clientId && opts?.clientSecret) args.push(opts.clientId, opts.clientSecret);
  if (opts?.noOpenBrowser) args.push('--auth-no-open-browser');

  return new Promise<string>((resolve, reject) => {
    const child = spawn(resolveRclonePath(), args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let urlSeen = false;
    const timer = setTimeout(
      () => {
        child.kill();
        reject(new Error('rclone authorize timed out waiting for the Google sign-in to complete.'));
      },
      opts?.timeoutMs ?? 5 * 60 * 1000
    );
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString();
      if (!urlSeen && opts?.onAuthUrl) {
        const m = /https?:\/\/127\.0\.0\.1:\d+\/auth\?\S+/.exec(stderr);
        if (m) {
          urlSeen = true;
          opts.onAuthUrl(m[0]);
        }
      }
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(rcloneErrorMessage({ stderr }, 'authorize')));
        return;
      }
      const token = extractTokenBlob(stdout);
      if (!token) {
        reject(new Error('rclone authorize completed but no token was found in its output.'));
        return;
      }
      resolve(token);
    });
  });
}

/** Pulls the `{...}` OAuth blob out of `rclone authorize` output (with or without its paste markers). */
export function extractTokenBlob(output: string): string | null {
  const marked = /--->\s*([\s\S]*?)\s*<---/.exec(output);
  const candidate = (marked ? marked[1] : output).trim();
  for (const line of candidate.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith('{') && /"access_token"/.test(t)) return t;
  }
  // Fall back to the whole candidate if it itself is the JSON.
  if (candidate.startsWith('{') && /"access_token"/.test(candidate)) return candidate.replace(/\s+/g, ' ');
  return null;
}
