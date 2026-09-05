import { mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { appDataDir } from '../paths.js';
import { exportVaultBuffer, inspectVaultBuffer, type VaultBackupDeps } from './exportVault.js';
import type { VaultBackupTarget, VaultBackupTargetsRepo, VaultBackupRun } from '../db/repositories/vaultBackupTargetsRepo.js';

export interface RunVaultBackupDeps extends VaultBackupDeps {
  vaultBackupTargetsRepo: VaultBackupTargetsRepo;
  // clientsRepo comes from VaultBackupDeps.
}

const ARKVAULT_EXT = '.arkvault';

function isInside(child: string, parent: string): boolean {
  const c = resolve(child) + sep;
  const p = resolve(parent) + sep;
  return c.startsWith(p);
}

/** Refuses a destination inside the app data dir or any client's backup folder (no self-referential backups). */
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

function pruneOldBackups(dir: string, keep: number, justWritten: string): void {
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

/** Writes one `.arkvault` to a target: atomic write, self-check, retention prune. Records a run + updates the target. */
export function runVaultBackup(deps: RunVaultBackupDeps, target: VaultBackupTarget): VaultBackupRun {
  const startedAt = new Date().toISOString();
  try {
    assertSafeDestination(deps, target.path);
    mkdirSync(target.path, { recursive: true });

    const buf = exportVaultBuffer(deps); // throws VaultLockedError if locked

    const stamp = startedAt.replace(/[:.]/g, '-');
    const dest = join(target.path, `arkode-vault-${stamp}${ARKVAULT_EXT}`);
    const tmp = `${dest}.tmp`;
    writeFileSync(tmp, buf);
    renameSync(tmp, dest);

    // Self-check: re-read and validate structure + checksum.
    inspectVaultBuffer(readFileSync(dest));

    pruneOldBackups(target.path, target.retentionCount ?? 0, dest);

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
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
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

/** Runs every enabled target. A no-op (returns allOk:true) when the vault is locked or has no enabled targets. */
export function runAllVaultBackups(deps: RunVaultBackupDeps): RunAllVaultBackupsResult {
  if (!deps.vaultState.isUnlocked()) return { runs: [], allOk: true };
  const targets = deps.vaultBackupTargetsRepo.listEnabled();
  const runs = targets.map((t) => runVaultBackup(deps, t));
  return { runs, allOk: runs.every((r) => r.status === 'Success') };
}
