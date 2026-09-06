import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestContext, type TestContext } from '../helpers/testContext.js';
import { DEFAULT_SCRYPT_PARAMS } from '../../src/vault/crypto.js';
import { inspectVaultBuffer, type VaultBackupDeps } from '../../src/vault/exportVault.js';
import {
  runVaultBackup,
  runDueVaultBackups,
  isVaultBackupDue,
  type RcloneVaultOps,
} from '../../src/vault/runVaultBackup.js';

const FAST = { ...DEFAULT_SCRYPT_PARAMS, N: 2 ** 12 };
const PW = 'master-pass-1';

function backupDeps(ctx: TestContext): VaultBackupDeps {
  return {
    db: ctx.db,
    vaultMetaRepo: ctx.vaultMetaRepo,
    vaultState: ctx.vaultState,
    vaultSecretStore: ctx.vaultSecretStore,
    secretStore: ctx.secretStore,
    clientsRepo: ctx.clientsRepo,
    backupSetsRepo: ctx.backupSetsRepo,
    transportsRepo: ctx.transportsRepo,
    databaseConnectionsRepo: ctx.databaseConnectionsRepo,
    tasksRepo: ctx.tasksRepo,
    settingsRepo: ctx.settingsRepo,
    fileBackupRepositoriesRepo: ctx.fileBackupRepositoriesRepo,
    fileBackupTasksRepo: ctx.fileBackupTasksRepo,
    replicationTargetsRepo: ctx.replicationTargetsRepo,
    vaultBackupTargetsRepo: ctx.vaultBackupTargetsRepo,
    vaultCredentialsRepo: ctx.vaultCredentialsRepo,
    vaultUrlsRepo: ctx.vaultUrlsRepo,
    vaultItemsRepo: ctx.vaultItemsRepo,
    keysDirOverride: mkdtempSync(join(tmpdir(), 'arkvault-keys-')),
    hardenKeyFile: () => {},
  };
}

/** A fake rclone that records calls and pretends the remote folder holds `existing`. */
function fakeRclone(existing: string[] = []) {
  const uploaded: string[] = [];
  const deleted: string[] = [];
  const ops: RcloneVaultOps = {
    withRcloneConfig: (async (_t, _remote, _crypt, fn) => fn('/tmp/fake-rclone.conf', 'base')) as RcloneVaultOps['withRcloneConfig'],
    copyTo: async ({ remoteFile }) => {
      uploaded.push(remoteFile);
    },
    lsf: async () => [...existing, ...uploaded.map((p) => p.split('/').pop()!)],
    deleteFile: async ({ remoteFile }) => {
      deleted.push(remoteFile.split('/').pop()!);
    },
  };
  return { ops, uploaded, deleted };
}

describe('runVaultBackup — Google Drive target', () => {
  let ctx: TestContext;
  beforeEach(() => {
    ctx = createTestContext();
    ctx.vaultState.init(PW, FAST);
    ctx.clientsRepo.create({ name: 'Rivera', localBasePath: 'D:\\B\\Rivera' });
  });

  it('generates locally + self-checks BEFORE upload, then uploads via copyto (no crypt), records Success', async () => {
    const t = ctx.vaultBackupTargetsRepo.createGoogleDrive({ remotePath: 'Arkode/Vault' });
    ctx.secretStore.set(t.rcloneConfigSecretRef!, '{"token":"{blob}"}');
    const fake = fakeRclone();
    // the file handed to copyto must already be a valid v2 .arkvault on disk
    fake.ops.copyTo = async ({ localFile, remoteFile }) => {
      expect(inspectVaultBuffer(readFileSync(localFile)).formatVersion).toBe(2);
      fake.uploaded.push(remoteFile);
    };

    const run = await runVaultBackup({ ...backupDeps(ctx), rcloneOps: fake.ops }, t);

    expect(run.status).toBe('Success');
    expect(fake.uploaded).toHaveLength(1);
    expect(fake.uploaded[0]).toMatch(/^Arkode\/Vault\/arkode-vault-.*\.arkvault$/);
    expect(run.sizeBytes).toBeGreaterThan(0);
    expect(ctx.vaultBackupTargetsRepo.getById(t.id)!.lastStatus).toBe('Success');
  });

  it('applies remote retention — keeps newest N, deletes older', async () => {
    const t = ctx.vaultBackupTargetsRepo.createGoogleDrive({ remotePath: 'Arkode/Vault', retentionCount: 2 });
    ctx.secretStore.set(t.rcloneConfigSecretRef!, '{"token":"{blob}"}');
    // three pre-existing older files
    const fake = fakeRclone([
      'arkode-vault-2026-01-01T00-00-00-000Z.arkvault',
      'arkode-vault-2026-02-01T00-00-00-000Z.arkvault',
      'arkode-vault-2026-03-01T00-00-00-000Z.arkvault',
    ]);

    const run = await runVaultBackup({ ...backupDeps(ctx), rcloneOps: fake.ops }, t);

    expect(run.status).toBe('Success');
    // keep 2 total => the brand-new one + the newest existing; the 2 oldest go.
    expect(fake.deleted.sort()).toEqual([
      'arkode-vault-2026-01-01T00-00-00-000Z.arkvault',
      'arkode-vault-2026-02-01T00-00-00-000Z.arkvault',
    ]);
  });

  it('an unconnected Drive target fails cleanly (no token)', async () => {
    const t = ctx.vaultBackupTargetsRepo.createGoogleDrive({ remotePath: 'Arkode/Vault' });
    const fake = fakeRclone();
    const run = await runVaultBackup({ ...backupDeps(ctx), rcloneOps: fake.ops }, t);
    expect(run.status).toBe('Failed');
    expect(run.errorMessage).toMatch(/not connected|authorize/i);
    expect(fake.uploaded).toHaveLength(0);
  });

  it('rclone errors are redacted before being persisted', async () => {
    const t = ctx.vaultBackupTargetsRepo.createGoogleDrive({ remotePath: 'Arkode/Vault' });
    ctx.secretStore.set(t.rcloneConfigSecretRef!, '{"token":"{blob}"}');
    const fake = fakeRclone();
    fake.ops.copyTo = async () => {
      throw new Error('rclone copyto failed: token=ya29.SECRET-VALUE expired');
    };
    const run = await runVaultBackup({ ...backupDeps(ctx), rcloneOps: fake.ops }, t);
    expect(run.status).toBe('Failed');
    expect(run.errorMessage).not.toContain('ya29.SECRET-VALUE');
    expect(run.errorMessage).toMatch(/redacted/i);
  });
});

describe('isVaultBackupDue / runDueVaultBackups', () => {
  let ctx: TestContext;
  beforeEach(() => {
    ctx = createTestContext();
    ctx.vaultState.init(PW, FAST);
    ctx.clientsRepo.create({ name: 'Rivera', localBasePath: 'D:\\B\\Rivera' });
  });

  it('never-run and last-failed targets are due; a recent Success is not', () => {
    const now = new Date('2026-09-05T12:00:00Z');
    const base = {
      id: 'x',
      kind: 'local_dir' as const,
      path: 'D:\\x',
      remotePath: null,
      rcloneConfigSecretRef: null,
      label: null,
      retentionCount: null,
      enabled: true,
      lastRunAt: null,
      lastStatus: null,
      lastError: null,
      createdAt: '',
      updatedAt: '',
    };
    expect(isVaultBackupDue(base, now)).toBe(true);
    expect(isVaultBackupDue({ ...base, lastStatus: 'Failed', lastRunAt: now.toISOString() }, now)).toBe(true);
    expect(
      isVaultBackupDue({ ...base, lastStatus: 'Success', lastRunAt: '2026-09-05T11:30:00Z' }, now)
    ).toBe(false); // 30 min ago — fresh
    expect(
      isVaultBackupDue({ ...base, lastStatus: 'Success', lastRunAt: '2026-09-04T00:00:00Z' }, now)
    ).toBe(true); // > freshness window
    expect(isVaultBackupDue({ ...base, enabled: false }, now)).toBe(false);
  });

  it('runDueVaultBackups only runs the due targets and skips repeat calls within the window', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'arkvault-due-'));
    ctx.vaultBackupTargetsRepo.create({ path: dir });

    const first = await runDueVaultBackups(backupDeps(ctx));
    expect(first.runs).toHaveLength(1);
    expect(first.runs[0].status).toBe('Success');

    // Immediately again — the target just succeeded, so nothing is due.
    const second = await runDueVaultBackups(backupDeps(ctx));
    expect(second.runs).toHaveLength(0);
  });

  it('is a no-op while the vault is locked', async () => {
    ctx.vaultBackupTargetsRepo.create({ path: mkdtempSync(join(tmpdir(), 'arkvault-locked-')) });
    ctx.vaultState.lock();
    const r = await runDueVaultBackups(backupDeps(ctx));
    expect(r.runs).toHaveLength(0);
  });
});
