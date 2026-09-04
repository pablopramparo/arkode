import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createWriteStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { toResticPath } from './paths.js';
import { resolveToolPath } from '../../toolPaths.js';
import type { ResticBackupSummary, ResticDiffStats, ResticSnapshot } from '../types.js';

const execFileAsync = promisify(execFile);

/**
 * Fixed regardless of the machine's real hostname. Verified against a real
 * repository that inconsistent --host values across backups broke restic's
 * own "find the previous snapshot for this path" matching — which both the
 * diffSnapshots-based files_deleted computation and forget's --path scoping
 * below depend on.
 */
export const RESTIC_HOST = 'arkode';

interface ExecErrorWithOutput {
  stdout?: string;
  stderr?: string;
}

/**
 * RESTIC_PATH when set (dev, and the Tauri sidecar which sets it
 * explicitly), otherwise the restic.exe vendored next to engine-cli.exe on
 * a real install — the same fallback the Postgres tools use, so a Windows
 * Scheduled Task running `file-task:run-due` (which inherits no env vars)
 * can still find restic. See toolPaths.ts.
 */
function resolveResticPath(): string {
  const configured = resolveToolPath('RESTIC_PATH', 'restic.exe');
  if (!configured) {
    throw new Error(
      'RESTIC_PATH is not configured and no vendored restic.exe was found next to engine-cli.exe — cannot run restic.'
    );
  }
  return configured;
}

function buildEnv(password: string): NodeJS.ProcessEnv {
  // Never pass the password via argv (visible to other processes/Task
  // Manager) — same RESTIC_PASSWORD-as-env-var pattern as PGPASSWORD/
  // MYSQL_PWD elsewhere in this codebase.
  return { ...process.env, RESTIC_PASSWORD: password };
}

async function execRestic(args: string[], password: string): Promise<{ stdout: string; stderr: string }> {
  const resticPath = resolveResticPath();
  return execFileAsync(resticPath, args, { env: buildEnv(password), maxBuffer: 64 * 1024 * 1024 });
}

/** restic still writes a `{"message_type":"exit_error",...}` JSON line to stdout before exiting nonzero — pull the clean human message out of it if present. */
function exitErrorFromStdout(stdout: string): string | null {
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as { message_type?: string; message?: string };
      if (parsed.message_type === 'exit_error' && parsed.message) return parsed.message;
    } catch {
      // not a JSON line — ignore
    }
  }
  return null;
}

/**
 * Scans stdout for restic's own `exit_error` line for a clean human message;
 * falls back to the raw child_process error otherwise.
 */
function resticErrorMessage(err: unknown, command: string): string {
  const fromStdout = exitErrorFromStdout((err as ExecErrorWithOutput)?.stdout ?? '');
  if (fromStdout) return fromStdout;
  const message = err instanceof Error ? err.message : String(err);
  return `restic ${command} failed: ${message}`;
}

const STALE_LOCK_RE = /already locked|unable to create lock|failed to create lock/i;

/** Whether a restic error is "the repository is locked" (as opposed to any other failure). Checks the error message plus any captured stdout/stderr. */
export function looksLikeStaleLock(err: unknown): boolean {
  const parts = [
    err instanceof Error ? err.message : String(err),
    (err as ExecErrorWithOutput)?.stdout ?? '',
    (err as ExecErrorWithOutput)?.stderr ?? '',
  ];
  return parts.some((p) => STALE_LOCK_RE.test(p));
}

/**
 * `restic unlock` — removes locks restic can prove are stale (a lock left by
 * a process that's no longer running on this host). It never removes a lock
 * from a genuinely-live process, so it's safe to call unconditionally when
 * we hit a lock error.
 */
export async function unlockRepository(repoPath: string, password: string): Promise<void> {
  try {
    await execRestic(['-r', repoPath, 'unlock'], password);
  } catch (err) {
    throw new Error(resticErrorMessage(err, 'unlock'));
  }
}

/**
 * Runs a restic operation, and if it fails because "the repository is
 * already locked", clears the stale lock with `restic unlock` and retries
 * once. For arkode this can only ever be a *stale* lock — `checkRepositoryLock`
 * already serializes every restic operation against a repository, so there
 * is never a legitimate concurrent restic process — and `restic unlock`
 * itself won't touch a live lock, so the retry is safe. Closes the "a run
 * killed mid-restic (update, reboot, power cut) leaves the repo locked until
 * someone runs `restic unlock` by hand" gap.
 */
export async function withStaleLockRetry<T>(
  repoPath: string,
  password: string,
  fn: () => Promise<T>,
  // Injectable only so a test can assert the retry path without a real
  // stale lock (which restic auto-clears on same-host dead PIDs, making it
  // near-impossible to reproduce deterministically). Production never passes it.
  unlock: (repoPath: string, password: string) => Promise<void> = unlockRepository
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!looksLikeStaleLock(err)) throw err;
    await unlock(repoPath, password);
    return fn();
  }
}

export interface ResticBackupStatus {
  /** 0..1 */
  percentDone?: number;
  totalFiles?: number;
  filesDone?: number;
  totalBytes?: number;
  bytesDone?: number;
  secondsRemaining?: number;
}

/**
 * Spawns restic (rather than execRestic's buffer-and-wait) so `backup
 * --json`'s intermediate `message_type:"status"` lines can be surfaced as
 * live progress. Still collects the full stdout/stderr for the final
 * summary/exit-error parse. onStdoutLine is called per newline-delimited
 * stdout line (already trimmed of the trailing newline, never empty).
 */
function spawnResticCollecting(
  args: string[],
  password: string,
  onStdoutLine: (line: string) => void
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const resticPath = resolveResticPath();
  return new Promise((resolve, reject) => {
    const child = spawn(resticPath, args, { env: buildEnv(password) });
    let stdout = '';
    let stderr = '';
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) onStdoutLine(line);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      const tail = buffer.trim();
      if (tail) onStdoutLine(tail);
      resolve({ code, stdout, stderr });
    });
  });
}

function parseJsonLines(stdout: string): unknown[] {
  const parsed: unknown[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      parsed.push(JSON.parse(trimmed));
    } catch {
      // restic's --json output is occasionally interleaved with plain
      // progress lines on some commands — skip anything that isn't valid
      // JSON rather than failing the whole parse.
    }
  }
  return parsed;
}

/**
 * Idempotent: if repoPath already has a restic config file, does not call
 * `init` again. Always resolves the repository's own id via `cat config`
 * (verified: this always returns clean JSON, unlike `init` itself, whose
 * own --json support was not relied on here).
 */
export async function initRepository(repoPath: string, password: string): Promise<{ resticRepoId: string }> {
  const alreadyExists = await stat(join(repoPath, 'config')).then(
    () => true,
    () => false
  );
  if (!alreadyExists) {
    try {
      await execRestic(['-r', repoPath, 'init'], password);
    } catch (err) {
      throw new Error(resticErrorMessage(err, 'init'));
    }
  }
  let stdout: string;
  try {
    ({ stdout } = await execRestic(['-r', repoPath, 'cat', 'config'], password));
  } catch (err) {
    throw new Error(resticErrorMessage(err, 'cat config'));
  }
  const parsed = JSON.parse(stdout) as { id: string };
  return { resticRepoId: parsed.id };
}

/**
 * `restic backup <abs path> --json --host arkode --tag <tag>`. sourcePath is
 * passed as a real Windows path (backup's source argument is read straight
 * off disk, unlike dump/restore --include, which reference a path *inside*
 * an existing snapshot and need toResticPath). Parses the NDJSON stream for
 * the final `message_type:"summary"` line; non-fatal per-file issues
 * (`message_type:"error"`) are collected into `warnings` rather than failing
 * the run.
 */
export async function runBackup(
  repoPath: string,
  password: string,
  sourcePath: string,
  opts: { tag: string; onStatus?: (status: ResticBackupStatus) => void }
): Promise<ResticBackupSummary> {
  const args = ['-r', repoPath, 'backup', sourcePath, '--json', '--host', RESTIC_HOST, '--tag', opts.tag];

  // Fresh per attempt — withStaleLockRetry may call this twice.
  const attempt = async (): Promise<ResticBackupSummary> => {
    const warnings: string[] = [];
    let summary: Record<string, unknown> | null = null;

    const handleLine = (line: string): void => {
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return; // restic interleaves the odd non-JSON progress line — skip it
      }
      if (obj.message_type === 'summary') {
        summary = obj;
      } else if (obj.message_type === 'status') {
        opts.onStatus?.({
          percentDone: obj.percent_done as number | undefined,
          totalFiles: obj.total_files as number | undefined,
          filesDone: obj.files_done as number | undefined,
          totalBytes: obj.total_bytes as number | undefined,
          bytesDone: obj.bytes_done as number | undefined,
          secondsRemaining: obj.seconds_remaining as number | undefined,
        });
      } else if (obj.message_type === 'error') {
        const item = obj.item ? ` (${obj.item as string})` : '';
        const errorMessage = (obj.error as { message?: string } | undefined)?.message ?? 'unknown error';
        warnings.push(`${(obj.during as string | undefined) ?? 'backup'}${item}: ${errorMessage}`);
      }
    };

    let result: { code: number | null; stdout: string; stderr: string };
    try {
      result = await spawnResticCollecting(args, password, handleLine);
    } catch (err) {
      throw new Error(resticErrorMessage(err, 'backup'));
    }
    if (result.code !== 0) {
      const fromStdout = exitErrorFromStdout(result.stdout);
      throw new Error(
        fromStdout ?? `restic backup failed (exit code ${result.code})${result.stderr.trim() ? `: ${result.stderr.trim()}` : ''}`
      );
    }
    // Cast defeats CFA narrowing `summary` to `never` — it's only ever
    // assigned inside the handleLine closure, which TS can't see.
    const summaryObj = summary as Record<string, unknown> | null;
    if (!summaryObj) {
      throw new Error('restic backup completed without reporting a summary line — treating as failed.');
    }

    return {
      snapshotId: summaryObj.snapshot_id as string,
      filesNew: summaryObj.files_new as number,
      filesChanged: summaryObj.files_changed as number,
      filesUnmodified: summaryObj.files_unmodified as number,
      dirsNew: summaryObj.dirs_new as number,
      dirsChanged: summaryObj.dirs_changed as number,
      totalFilesProcessed: summaryObj.total_files_processed as number,
      totalBytesProcessed: summaryObj.total_bytes_processed as number,
      dataAdded: summaryObj.data_added as number,
      dataAddedPacked: summaryObj.data_added_packed as number,
      durationMs: Math.round(((summaryObj.total_duration as number | undefined) ?? 0) * 1000),
      warnings,
    };
  };

  return withStaleLockRetry(repoPath, password, attempt);
}

/**
 * `restic diff <from> <to> --json` — used to compute files_deleted, which
 * `restic backup --json`'s own summary line has no field for at all
 * (confirmed empirically: files_new/files_changed/files_unmodified cover
 * everything it reports).
 */
export async function diffSnapshots(
  repoPath: string,
  password: string,
  fromSnapshotId: string,
  toSnapshotId: string
): Promise<ResticDiffStats> {
  let stdout: string;
  try {
    ({ stdout } = await execRestic(['-r', repoPath, 'diff', fromSnapshotId, toSnapshotId, '--json'], password));
  } catch (err) {
    throw new Error(resticErrorMessage(err, 'diff'));
  }
  for (const line of parseJsonLines(stdout)) {
    const obj = line as Record<string, unknown>;
    if (obj.message_type === 'statistics') {
      const added = obj.added as { files?: number } | undefined;
      const removed = obj.removed as { files?: number } | undefined;
      return {
        filesAdded: added?.files ?? 0,
        filesRemoved: removed?.files ?? 0,
        filesChanged: (obj.changed_files as number | undefined) ?? 0,
      };
    }
  }
  throw new Error('restic diff completed without reporting statistics.');
}

/**
 * Pure arg-construction, split out from forget() below specifically so the
 * floor/union logic is unit-testable without a real restic binary. Always
 * unions in a floor of `--keep-last 1` (restic's multiple --keep-* flags
 * are a union of keep-sets, verified against a real repository — confirmed
 * by forcing a --keep-within that matched nothing while --keep-last still
 * protected the newest snapshot) so the "at least one survivor" invariant
 * holds even if the caller's own policy would otherwise remove everything.
 * Always scoped with `--path` so a repository shared by several tasks only
 * ever forgets *this* task's own snapshots.
 */
export function buildForgetArgs(repoPath: string, opts: { path: string; keepLast?: number; keepWithinDays?: number }): string[] {
  const args = ['-r', repoPath, 'forget', '--path', opts.path, '--json'];
  args.push('--keep-last', String(Math.max(1, opts.keepLast ?? 0)));
  if (opts.keepWithinDays != null) args.push('--keep-within', `${opts.keepWithinDays}d`);
  return args;
}

/** `restic forget` — see buildForgetArgs for the exact flags/reasoning. */
export async function forget(
  repoPath: string,
  password: string,
  opts: { path: string; keepLast?: number; keepWithinDays?: number }
): Promise<{ removedSnapshotIds: string[] }> {
  const args = buildForgetArgs(repoPath, opts);

  let stdout: string;
  try {
    ({ stdout } = await withStaleLockRetry(repoPath, password, () => execRestic(args, password)));
  } catch (err) {
    throw new Error(resticErrorMessage(err, 'forget'));
  }

  let groups: Array<{ remove?: Array<{ id: string }> }>;
  try {
    groups = JSON.parse(stdout);
  } catch {
    throw new Error('restic forget produced output that could not be parsed as JSON.');
  }

  const removedSnapshotIds: string[] = [];
  for (const group of groups) {
    for (const snap of group.remove ?? []) {
      removedSnapshotIds.push(snap.id);
    }
  }
  return { removedSnapshotIds };
}

/**
 * Forgets exactly one snapshot by id — restic's positional-argument form,
 * distinct from forget()'s policy-based `--path/--keep-*` form above (which
 * always evaluates every snapshot under a path against keep-rules and
 * unions in a `--keep-last 1` survivor floor). Used for an explicit manual
 * "delete this one backup" action, which is deliberately allowed to remove
 * the only remaining snapshot if that's what was asked for — the survivor
 * floor is a retention-policy safeguard, not a restriction on a human's own
 * deliberate choice. Metadata-only and immediate, like forget() itself;
 * doesn't reclaim disk space — that's prune()'s separate job.
 */
export async function forgetSnapshot(repoPath: string, password: string, snapshotId: string): Promise<void> {
  try {
    await execRestic(['-r', repoPath, 'forget', snapshotId], password);
  } catch (err) {
    throw new Error(resticErrorMessage(err, 'forget'));
  }
}

/** Real on-disk size of a directory tree (sum of file sizes). For a restic repo this is its deduplicated footprint. */
export async function directorySizeBytes(dir: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await directorySizeBytes(full);
    } else if (entry.isFile()) {
      total += (await stat(full)).size;
    }
  }
  return total;
}

/**
 * `restic prune --max-unused <value>`. Deliberately does NOT pass --json:
 * confirmed against a real repository that restic 0.19.1 silently ignores
 * --json for this specific command (plain progress text either way, no
 * error) — parsing that human-readable text would be fragile across restic
 * versions, so bytesReclaimed is instead measured directly (real disk usage
 * of repoPath, before vs. after), the same way it was verified by hand in
 * the PoC. Never called after every backup — this is repository maintenance
 * with its own separate, less frequent schedule (see runFileBackupMaintenance.ts).
 */
export async function prune(repoPath: string, password: string, opts: { maxUnused: string }): Promise<{ bytesReclaimed: number }> {
  const before = await directorySizeBytes(repoPath);
  try {
    await withStaleLockRetry(repoPath, password, () => execRestic(['-r', repoPath, 'prune', '--max-unused', opts.maxUnused], password));
  } catch (err) {
    throw new Error(resticErrorMessage(err, 'prune'));
  }
  const after = await directorySizeBytes(repoPath);
  return { bytesReclaimed: Math.max(0, before - after) };
}

/**
 * `restic check --json [--read-data]`. Also repository maintenance, not run
 * as part of a normal backup — --read-data in particular reads every byte
 * in the repository and was only verified cheap at the PoC's ~390MB scale,
 * not at real production repo sizes.
 */
export async function check(repoPath: string, password: string, opts: { readData: boolean }): Promise<{ ok: boolean; message?: string }> {
  const args = ['-r', repoPath, 'check', '--json'];
  if (opts.readData) args.push('--read-data');
  let stdout: string;
  try {
    ({ stdout } = await withStaleLockRetry(repoPath, password, () => execRestic(args, password)));
  } catch (err) {
    return { ok: false, message: resticErrorMessage(err, 'check') };
  }
  for (const line of parseJsonLines(stdout)) {
    const obj = line as Record<string, unknown>;
    if (obj.message_type === 'summary') {
      const numErrors = (obj.num_errors as number | undefined) ?? 0;
      return { ok: numErrors === 0, message: numErrors === 0 ? undefined : `restic check found ${numErrors} error(s).` };
    }
  }
  return { ok: false, message: 'restic check completed without reporting a summary line.' };
}

/**
 * Restores an entire snapshot to targetDir (a plain local folder — see the
 * plan's UI section for why this app restores to disk rather than
 * zip-streaming a browser download). Verified against a real repository:
 * restic can exit nonzero (e.g. a non-fatal permission error restoring a
 * top-level ancestor directory's timestamp) while still having restored
 * 100% of the actual files — so a nonzero exit is only treated as a hard
 * failure when stdout shows no "Summary: Restored" line at all; otherwise
 * it's surfaced as a warning.
 */
export async function restoreSnapshot(
  repoPath: string,
  password: string,
  snapshotId: string,
  targetDir: string
): Promise<{ filesRestored: number; warning?: string }> {
  let stdout = '';
  let warning: string | undefined;
  try {
    ({ stdout } = await execRestic(['-r', repoPath, 'restore', snapshotId, '--target', targetDir], password));
  } catch (err) {
    stdout = (err as ExecErrorWithOutput)?.stdout ?? '';
    if (!/Summary: Restored/.test(stdout)) {
      throw new Error(resticErrorMessage(err, 'restore'));
    }
    warning = resticErrorMessage(err, 'restore');
  }
  const match = /Restored (\d+)/.exec(stdout);
  return { filesRestored: match ? Number(match[1]) : 0, warning };
}

/**
 * Streams a single file from inside a snapshot straight to destPath via
 * spawn+pipe — binary-safe by construction (Node's child_process stdio
 * piping, unlike the PowerShell `>` redirection that corrupted a large
 * binary dump during manual PoC testing; irrelevant here since nothing
 * shells through a text-mode redirect).
 */
export async function dumpFile(
  repoPath: string,
  password: string,
  snapshotId: string,
  absoluteSourceFilePath: string,
  destPath: string
): Promise<void> {
  const internalPath = toResticPath(absoluteSourceFilePath);
  const resticPath = resolveResticPath();

  await new Promise<void>((resolve, reject) => {
    const child = spawn(resticPath, ['-r', repoPath, 'dump', snapshotId, internalPath], { env: buildEnv(password) });
    const out = createWriteStream(destPath);
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.stdout.pipe(out);
    child.on('error', reject);
    out.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`restic dump failed (exit ${code}): ${stderr.trim() || 'unknown error'}`));
    });
  });
}

export async function listSnapshots(repoPath: string, password: string, opts?: { path?: string }): Promise<ResticSnapshot[]> {
  const args = ['-r', repoPath, 'snapshots', '--json'];
  if (opts?.path) args.push('--path', opts.path);
  let stdout: string;
  try {
    ({ stdout } = await execRestic(args, password));
  } catch (err) {
    throw new Error(resticErrorMessage(err, 'snapshots'));
  }
  const parsed = JSON.parse(stdout) as Array<{ id: string; time: string; paths: string[]; tags?: string[] }>;
  return parsed.map((s) => ({ id: s.id, time: s.time, paths: s.paths, tags: s.tags ?? [] }));
}
