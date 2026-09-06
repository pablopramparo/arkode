import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { appDataDir } from '../paths.js';
import { redactSecrets } from '../logging/redact.js';
import { rcloneRemoteSection } from '../replication/rcloneConfig.js';
import { rcloneCopyTo, rcloneDeleteFile, rcloneLsf, withRcloneConfig } from '../replication/rcloneClient.js';
import type { RcloneDriveConfig } from '../replication/types.js';
import { exportVaultBuffer, inspectVaultBuffer, type VaultBackupDeps } from './exportVault.js';
import type { VaultBackupTarget, VaultBackupRun } from '../db/repositories/vaultBackupTargetsRepo.js';

/** rclone operations the Google Drive path uses — overridable in tests only. */
export interface RcloneVaultOps {
  withRcloneConfig: typeof withRcloneConfig;
  copyTo: typeof rcloneCopyTo;
  lsf: typeof rcloneLsf;
  deleteFile: typeof rcloneDeleteFile;
}

export interface RunVaultBackupDeps extends VaultBackupDeps {
  /** Test seam — production never sets this. */
  rcloneOps?: RcloneVaultOps;
}

const ARKVAULT_EXT = '.arkvault';

/**
 * A target whose last **successful** backup is older than this (or that has
 * never succeeded) is "due". Chosen so backups happen roughly daily, driven
 * by app start / vault unlock — WITHOUT re-running on every restart within
 * the same day and WITHOUT needing Arkode to stay open for 24 h.
 */
export const VAULT_BACKUP_FRESH_MS = 20 * 60 * 60 * 1000;

function isInside(child: string, parent: string): boolean {
  const c = resolve(child) + sep;
  const p = resolve(parent) + sep;
  return c.startsWith(p);
}

/** Refuses a local destination inside the app data dir or any client's backup folder (no self-referential backups). */
function assertSafeDestination(deps: RunVaultBackupDeps, path: string): void {
  if (isInside(path, appDataDir()) || isInside(appDataDir(), path)) {
    throw new Error('The vault backup destination cannot be inside the arkode data directory.');
  }
  for (const client of deps.clientsRepo.listAll()) {
    if (client.localBasePath && (isInside(path, client.localBasePath) || isInside(client.localBasePath, path))) {
      throw new Error(`The vault backup destination overlaps a client's backup folder (${client.name}).`);
    }
  }
}

function pruneOldLocalBackups(dir: string, keep: number, justWritten: string): void {
  if (!keep || keep <= 0) return;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(ARKVAULT_EXT))
    .map((f) => ({ f, full: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const entry of files.slice(keep)) {
    if (entry.full === justWritten) continue; // never delete the one we just wrote
    try {
      rmSync(entry.full, { force: true });
    } catch {
      /* best-effort */
    }
  }
}

/** Deletes older `.arkvault` files in the remote folder, keeping the newest `keep`. Filenames sort chronologically. */
async function pruneOldRemoteBackups(
  ops: RcloneVaultOps,
  configPath: string,
  remoteSection: string,
  remotePath: string,
  keep: number,
  justWritten: string
): Promise<void> {
  if (!keep || keep <= 0) return;
  const names = (await ops.lsf({ configPath, remoteSection, remotePath, include: `*${ARKVAULT_EXT}` }))
    .filter((n) => n !== justWritten)
    .sort()
    .reverse(); // newest first (ISO timestamp in the name)
  for (const name of names.slice(keep - 1)) {
    try {
      await ops.deleteFile({ configPath, remoteSection, remoteFile: `${remotePath}/${name}` });
    } catch {
      /* best-effort */
    }
  }
}

function stampedName(startedAtIso: string): string {
  return `arkode-vault-${startedAtIso.replace(/[:.]/g, '-')}${ARKVAULT_EXT}`;
}

/** Never let a token/config value survive into a persisted run error. */
function redactRunError(message: string): string {
  return redactSecrets(message);
}

async function runLocalDirBackup(deps: RunVaultBackupDeps, target: VaultBackupTarget, startedAt: string): Promise<VaultBackupRun> {
  if (!target.path) throw new Error('local_dir target has no path.');
  assertSafeDestination(deps, target.path);
  mkdirSync(target.path, { recursive: true });

  const buf = exportVaultBuffer(deps); // throws VaultLockedError if locked

  const dest = join(target.path, stampedName(startedAt));
  const tmp = `${dest}.tmp`;
  writeFileSync(tmp, buf);
  renameSync(tmp, dest);

  inspectVaultBuffer(readFileSync(dest)); // self-check: structure + checksum

  pruneOldLocalBackups(target.path, target.retentionCount ?? 0, dest);

  deps.vaultBackupTargetsRepo.recordResult(target.id, 'Success', null);
  return deps.vaultBackupTargetsRepo.recordRun({
    targetId: target.id,
    status: 'Success',
    filePath: dest,
    sizeBytes: buf.length,
    startedAt,
    finishedAt: new Date().toISOString(),
    errorMessage: null,
  });
}

async function runGoogleDriveBackup(
  deps: RunVaultBackupDeps,
  target: VaultBackupTarget,
  startedAt: string
): Promise<VaultBackupRun> {
  if (!target.remotePath || !target.rcloneConfigSecretRef) {
    throw new Error('google_drive target is missing its remote path or config ref.');
  }
  const raw = deps.secretStore.get(target.rcloneConfigSecretRef);
  if (!raw) {
    throw new Error('Google Drive is not connected for this destination — authorize an account first.');
  }
  let drive: RcloneDriveConfig;
  try {
    drive = JSON.parse(raw) as RcloneDriveConfig;
  } catch {
    throw new Error('The stored Google Drive configuration is corrupt.');
  }

  const ops: RcloneVaultOps = deps.rcloneOps ?? {
    withRcloneConfig,
    copyTo: rcloneCopyTo,
    lsf: rcloneLsf,
    deleteFile: rcloneDeleteFile,
  };

  // Generate + self-check LOCALLY before anything is uploaded.
  const stagingDir = mkdtempSync(join(tmpdir(), 'arkode-vault-'));
  try {
    const buf = exportVaultBuffer(deps); // throws VaultLockedError if locked
    const name = stampedName(startedAt);
    const staged = join(stagingDir, name);
    const stagedTmp = `${staged}.tmp`;
    writeFileSync(stagedTmp, buf);
    renameSync(stagedTmp, staged);
    inspectVaultBuffer(readFileSync(staged)); // self-check BEFORE upload

    await ops.withRcloneConfig(
      { encryptWithCrypt: false }, // the .arkvault is already encrypted under the master password — no extra rclone crypt
      { provider: 'rclone_drive', drive },
      undefined,
      async (configPath, remoteSection) => {
        await ops.copyTo({
          configPath,
          remoteSection,
          localFile: staged,
          remoteFile: `${target.remotePath}/${name}`,
        });
        await pruneOldRemoteBackups(
          ops,
          configPath,
          remoteSection,
          target.remotePath!,
          target.retentionCount ?? 0,
          name
        );
      }
    );

    deps.vaultBackupTargetsRepo.recordResult(target.id, 'Success', null);
    return deps.vaultBackupTargetsRepo.recordRun({
      targetId: target.id,
      status: 'Success',
      filePath: `${rcloneRemoteSection({ encryptWithCrypt: false })}:${target.remotePath}/${name}`,
      sizeBytes: buf.length,
      startedAt,
      finishedAt: new Date().toISOString(),
      errorMessage: null,
    });
  } finally {
    try {
      rmSync(stagingDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

/** Writes one `.arkvault` to a target (local dir or Google Drive). Records a run + updates the target. Never throws. */
export async function runVaultBackup(deps: RunVaultBackupDeps, target: VaultBackupTarget): Promise<VaultBackupRun> {
  const startedAt = new Date().toISOString();
  try {
    if (target.kind === 'google_drive') return await runGoogleDriveBackup(deps, target, startedAt);
    return await runLocalDirBackup(deps, target, startedAt);
  } catch (err) {
    const message = redactRunError(err instanceof Error ? err.message : String(err));
    deps.vaultBackupTargetsRepo.recordResult(target.id, 'Failed', message);
    return deps.vaultBackupTargetsRepo.recordRun({
      targetId: target.id,
      status: 'Failed',
      filePath: null,
      sizeBytes: null,
      startedAt,
      finishedAt: new Date().toISOString(),
      errorMessage: message,
    });
  }
}

export interface RunAllVaultBackupsResult {
  runs: VaultBackupRun[];
  allOk: boolean;
}

/** Runs EVERY enabled target now (manual "Crear backup ahora" / `vault:backup`). No-op when the vault is locked. */
export async function runAllVaultBackups(deps: RunVaultBackupDeps): Promise<RunAllVaultBackupsResult> {
  if (!deps.vaultState.isUnlocked()) return { runs: [], allOk: true };
  const runs: VaultBackupRun[] = [];
  for (const t of deps.vaultBackupTargetsRepo.listEnabled()) {
    runs.push(await runVaultBackup(deps, t));
  }
  return { runs, allOk: runs.every((r) => r.status === 'Success') };
}

/** True when this target has no recent-enough SUCCESSFUL backup and should run now. */
export function isVaultBackupDue(target: VaultBackupTarget, now: Date = new Date(), freshMs = VAULT_BACKUP_FRESH_MS): boolean {
  if (!target.enabled) return false;
  if (target.lastStatus !== 'Success' || !target.lastRunAt) return true;
  return now.getTime() - new Date(target.lastRunAt).getTime() >= freshMs;
}

/**
 * Runs only the targets that are "due" (see `isVaultBackupDue`). This is
 * what the running app calls at startup / unlock and then periodically —
 * repeated app open/close within the freshness window does NOT re-generate
 * a backup, because due-ness is decided from the persisted last-success time.
 * No-op when the vault is locked.
 */
export async function runDueVaultBackups(
  deps: RunVaultBackupDeps,
  opts: { now?: Date; freshMs?: number } = {}
): Promise<RunAllVaultBackupsResult> {
  if (!deps.vaultState.isUnlocked()) return { runs: [], allOk: true };
  const now = opts.now ?? new Date();
  const runs: VaultBackupRun[] = [];
  for (const t of deps.vaultBackupTargetsRepo.listEnabled()) {
    if (isVaultBackupDue(t, now, opts.freshMs)) runs.push(await runVaultBackup(deps, t));
  }
  return { runs, allOk: runs.every((r) => r.status === 'Success') };
}
