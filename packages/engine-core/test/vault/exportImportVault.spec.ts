import { describe, expect, it, beforeEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createTestContext, type TestContext } from '../helpers/testContext.js';
import { DEFAULT_SCRYPT_PARAMS, deriveKek, wrapDek, buildVerifier, generateDek, generateSalt, encryptBytes } from '../../src/vault/crypto.js';
import { writeCredentialSecret, readCredentialSecret, newCredentialSecretRef } from '../../src/vault/credentialBlob.js';
import {
  ArkvaultParseError,
  exportVaultBuffer,
  importVaultBuffer,
  inspectVaultBuffer,
  ARKVAULT_FORMAT_VERSION,
  type VaultBackupDeps,
} from '../../src/vault/exportVault.js';
import { runVaultBackup } from '../../src/vault/runVaultBackup.js';
import { WrongMasterPasswordError } from '../../src/vault/vaultState.js';
import { appDataDir } from '../../src/paths.js';
import { POCKET_DEK_SECRET_REF } from '../../src/vault/pocket/pocketDek.js';
import { POCKET_RCLONE_CONFIG_SECRET_REF } from '../../src/vault/pocket/pocketDriveAuth.js';

const FAST = { ...DEFAULT_SCRYPT_PARAMS, N: 2 ** 12 };
const PW = 'master-pass-1';
const PEM = '-----BEGIN OPENSSH PRIVATE KEY-----\nZmFrZS1rZXk=\n-----END OPENSSH PRIVATE KEY-----\n';

let keysDir: string;
beforeEach(() => {
  keysDir = mkdtempSync(join(tmpdir(), 'arkvault-keys-'));
});

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
    pocketStateRepo: ctx.pocketStateRepo,
    keysDirOverride: keysDir,
    hardenKeyFile: () => {},
  };
}

/** Seeds a source machine with the full operational surface: infra + secrets + vault. */
function seedFullSource(ctx: TestContext) {
  ctx.vaultState.init(PW, FAST);
  const rivera = ctx.clientsRepo.create({ name: 'Rivera', localBasePath: 'D:\\B\\Rivera' });
  const carena = ctx.clientsRepo.create({ name: 'Carena', localBasePath: 'D:\\B\\Carena' });

  const set = ctx.backupSetsRepo.create({ clientId: rivera.id, name: 'Sitio Rivera' });

  // an SSH transport with a real key file + Tier-1 passphrase
  const keyFile = join(keysDir, 'source.key');
  require('node:fs').writeFileSync(keyFile, PEM);
  ctx.secretStore.set('transport:passphrase:src', 'key-pass-1');
  const sshT = ctx.transportsRepo.createSsh({
    clientId: rivera.id, name: 'Rivera VPS', host: 'vps.rivera.com', port: 22, username: 'arkode',
    privateKeyPath: keyFile, passphraseSecretRef: 'transport:passphrase:src', knownHostFingerprint: 'SHA256:abc',
  });
  // an FTP transport with a Tier-1 password
  ctx.secretStore.set('transport:password:src', 'ftp-pw-1');
  ctx.transportsRepo.createFtp({
    clientId: rivera.id, name: 'ERP FTP', host: 'ftp.rivera.com', port: 21, username: 'erp',
    passwordSecretRef: 'transport:password:src',
  });

  // a DB connection with a Tier-1 password
  ctx.secretStore.set('databaseConnection:password:src', 'db-pw-1');
  const dbc = ctx.databaseConnectionsRepo.create({
    clientId: rivera.id, name: 'Rivera PG', engine: 'postgres', host: 'db.rivera.com', port: 5432,
    databaseName: 'rivera', username: 'backup', passwordSecretRef: 'databaseConnection:password:src', sslMode: 'require',
  });

  // a direct_dump task with a weekly schedule + backup set
  const task = ctx.tasksRepo.createDirectDump({
    clientId: rivera.id, databaseConnectionId: dbc.id, name: 'Rivera nightly', dbEngine: 'postgres',
    retentionCount: 7, backupSetId: set.id,
  });
  ctx.tasksRepo.setSchedule(task.id, { scheduleTime: '03:00', scheduleEnabled: true, scheduleFrequency: 'weekly', scheduleDaysOfWeek: [1, 3, 5] });

  // a remote_dump (host) task on the ssh transport
  ctx.tasksRepo.createRemoteDump({
    clientId: rivera.id, transportId: sshT.id, name: 'Rivera remote', dbEngine: 'mysql',
    remoteCommand: 'mysqldump rivera > {outputPath}', remoteOutputPathTemplate: '/tmp/rivera_{date:YYYYMMDD}.sql',
  });

  // a file-backup repository with a restic recovery key + a local_folder task
  ctx.secretStore.set('file-backup-repository:src:password', 'RESTIC-RECOVERY-KEY-xyz');
  const repo = ctx.fileBackupRepositoriesRepo.create({ clientId: rivera.id, repoPath: 'D:\\B\\Rivera\\_restic-repo', passwordSecretRef: 'file-backup-repository:src:password' });
  ctx.fileBackupRepositoriesRepo.markInitialized(repo.id, 'restic-repo-id-1');
  const ftask = ctx.fileBackupTasksRepo.createLocalFolder({ clientId: rivera.id, repositoryId: repo.id, name: 'Uploads', sourcePath: 'D:\\sites\\rivera\\uploads', retentionCount: 10 });
  ctx.fileBackupTasksRepo.setSchedule(ftask.id, { scheduleTime: '04:00', scheduleEnabled: true, scheduleFrequency: 'daily' });

  // a replication target (drive + crypt) for db dumps
  ctx.secretStore.set('replication:src:db_dumps:rclone-config', '{"token":"{oauth-blob}"}');
  ctx.secretStore.set('replication:src:db_dumps:crypt-password', 'CRYPT-PW-abc');
  ctx.replicationTargetsRepo.create({
    clientId: rivera.id, content: 'db_dumps', provider: 'rclone_drive', remotePath: 'arkode/rivera',
    rcloneConfigSecretRef: 'replication:src:db_dumps:rclone-config', encryptWithCrypt: true,
    cryptPasswordSecretRef: 'replication:src:db_dumps:crypt-password',
  });

  // tool registry
  ctx.settingsRepo.set('postgresToolRegistry', JSON.stringify({ '16': { pgDumpPath: 'C:/pg/pg_dump.exe', pgRestorePath: 'C:/pg/pg_restore.exe' } }));

  // portable vault-backup destinations: a connected Google Drive one + a local one
  const gdrive = ctx.vaultBackupTargetsRepo.createGoogleDrive({ remotePath: 'Arkode/Vault', label: 'pablo@gmail.com', retentionCount: 10 });
  ctx.secretStore.set(gdrive.rcloneConfigSecretRef!, '{"token":"{vault-oauth-blob}"}');
  ctx.vaultBackupTargetsRepo.create({ path: 'D:\\Backups\\Arkode', retentionCount: 5 });

  // a vault credential linked to the DB connection (reuse bridge)
  const credRef = newCredentialSecretRef();
  writeCredentialSecret(ctx.vaultSecretStore, credRef, { password: 'db-pw-1', notes: 'prod' });
  const cred = ctx.vaultCredentialsRepo.create({
    clientId: rivera.id, name: 'Rivera PG cred', kind: 'postgres', host: 'db.rivera.com', port: 5432,
    username: 'backup', databaseName: 'rivera', secretBlobRef: credRef,
  });
  ctx.vaultCredentialsRepo.setLink(cred.id, { linkedDatabaseConnectionId: dbc.id });
  ctx.vaultCredentialsRepo.setOperationalSyncState(cred.id, 'ok', null);

  // a URL + a sensitive note on the other client
  ctx.vaultUrlsRepo.create({ clientId: rivera.id, name: 'CloudPanel', url: 'https://panel.rivera.com', linkedCredentialId: cred.id });
  const noteRef = 'vault:item:src-note';
  ctx.vaultSecretStore.set(noteRef, 'root pw hunter2');
  ctx.vaultItemsRepo.create({ clientId: carena.id, type: 'note', title: 'Carena root', isSensitive: true, bodyBlobRef: noteRef });

  return { rivera, carena, sshT, dbc, task, repo, cred, gdrive };
}

describe('exportVaultBuffer / importVaultBuffer — full disaster recovery (v2)', () => {
  it('exports at format v2', () => {
    const src = createTestContext();
    seedFullSource(src);
    expect(inspectVaultBuffer(exportVaultBuffer(backupDeps(src))).formatVersion).toBe(ARKVAULT_FORMAT_VERSION);
    expect(ARKVAULT_FORMAT_VERSION).toBe(2);
  });

  it('a fresh machine + one file + the master password rebuilds EVERYTHING', () => {
    const src = createTestContext();
    seedFullSource(src);
    const buf = exportVaultBuffer(backupDeps(src));

    const dst = createTestContext();
    expect(dst.vaultState.isInitialized()).toBe(false);
    const r = importVaultBuffer(backupDeps(dst), buf, PW);

    expect(r.formatVersion).toBe(2);
    expect(r.clientErrors).toEqual([]);
    expect({
      clients: r.clientsCreated,
      sets: r.backupSetsCreated,
      transports: r.transportsCreated,
      dbConns: r.databaseConnectionsCreated,
      tasks: r.backupTasksCreated,
      fileRepos: r.fileBackupRepositoriesCreated,
      fileTasks: r.fileBackupTasksCreated,
      replTargets: r.replicationTargetsCreated,
      vaultBackupTargets: r.vaultBackupTargetsCreated,
      registries: r.toolRegistriesRestored,
      creds: r.credentialsCreated,
      urls: r.urlsCreated,
      items: r.itemsCreated,
    }).toEqual({
      clients: 2, sets: 1, transports: 2, dbConns: 1, tasks: 2,
      fileRepos: 1, fileTasks: 1, replTargets: 1, vaultBackupTargets: 2, registries: 1, creds: 1, urls: 1, items: 1,
    });
    expect(dst.vaultState.isUnlocked()).toBe(true);

    // --- portable vault-backup destinations: Drive restored ENABLED with its
    //     OAuth token (no re-auth needed); local restored DISABLED + warned.
    const vbts = dst.vaultBackupTargetsRepo.list();
    const drive = vbts.find((t) => t.kind === 'google_drive')!;
    expect(drive.remotePath).toBe('Arkode/Vault');
    expect(drive.label).toBe('pablo@gmail.com');
    expect(drive.enabled).toBe(true);
    expect(JSON.parse(dst.secretStore.get(drive.rcloneConfigSecretRef!)!).token).toBe('{vault-oauth-blob}');
    const localVbt = vbts.find((t) => t.kind === 'local_dir')!;
    expect(localVbt.enabled).toBe(false);
    expect(r.warnings.some((w) => /Local vault-backup destination/i.test(w))).toBe(true);

    const rivera = dst.clientsRepo.getByName('Rivera')!;

    // --- SSH transport: key file regenerated + ACL path set + passphrase in Tier-1
    const sshT = dst.transportsRepo.listByClient(rivera.id).find((t) => t.type === 'ssh')!;
    expect(sshT.privateKeyPath).toBeTruthy();
    expect(existsSync(sshT.privateKeyPath!)).toBe(true);
    expect(readFileSync(sshT.privateKeyPath!, 'utf8')).toBe(PEM);
    expect(sshT.knownHostFingerprint).toBe('SHA256:abc');
    expect(dst.secretStore.get(sshT.passphraseSecretRef!)).toBe('key-pass-1');

    // --- FTP transport: password in Tier-1
    const ftpT = dst.transportsRepo.listByClient(rivera.id).find((t) => t.type === 'ftp')!;
    expect(dst.secretStore.get(ftpT.passwordSecretRef!)).toBe('ftp-pw-1');

    // --- DB connection: password + sslMode in Tier-1
    const dbc = dst.databaseConnectionsRepo.listByClient(rivera.id)[0];
    expect(dbc.sslMode).toBe('require');
    expect(dst.secretStore.get(dbc.passwordSecretRef!)).toBe('db-pw-1');

    // --- tasks + schedules + backup set remap
    const tasks = dst.tasksRepo.listByClient(rivera.id);
    expect(tasks.map((t) => t.name).sort()).toEqual(['Rivera nightly', 'Rivera remote']);
    const nightly = tasks.find((t) => t.name === 'Rivera nightly')!;
    expect(nightly.strategy).toBe('direct_dump');
    expect(nightly.databaseConnectionId).toBe(dbc.id); // remapped id
    expect(nightly.scheduleTime).toBe('03:00');
    expect(nightly.scheduleFrequency).toBe('weekly');
    expect(nightly.scheduleDaysOfWeek).toEqual([1, 3, 5]);
    expect(nightly.retentionCount).toBe(7);
    const set = dst.backupSetsRepo.listByClient(rivera.id)[0];
    expect(nightly.backupSetId).toBe(set.id);
    const remote = tasks.find((t) => t.name === 'Rivera remote')!;
    expect(remote.transportId).toBe(sshT.id); // remapped
    expect(remote.remoteCommand).toContain('mysqldump');

    // --- restic recovery key recovered (the critical one)
    const repo = dst.fileBackupRepositoriesRepo.getByClientId(rivera.id)!;
    expect(dst.secretStore.get(repo.passwordSecretRef)).toBe('RESTIC-RECOVERY-KEY-xyz');
    expect(repo.resticRepoId).toBe('restic-repo-id-1');
    expect(repo.initializedAt).toBeTruthy();
    const ftask = dst.fileBackupTasksRepo.listByClient(rivera.id)[0];
    expect(ftask.repositoryId).toBe(repo.id);
    expect(ftask.sourcePath).toBe('D:\\sites\\rivera\\uploads');
    expect(ftask.scheduleTime).toBe('04:00');

    // --- replication: rclone config + crypt password recovered
    const rt = dst.replicationTargetsRepo.listByClient(rivera.id)[0];
    expect(rt.provider).toBe('rclone_drive');
    expect(rt.encryptWithCrypt).toBe(true);
    expect(dst.secretStore.get(rt.rcloneConfigSecretRef!)).toBe('{"token":"{oauth-blob}"}');
    expect(dst.secretStore.get(rt.cryptPasswordSecretRef!)).toBe('CRYPT-PW-abc');

    // --- tool registry
    expect(JSON.parse(dst.settingsRepo.get('postgresToolRegistry')!)['16'].pgDumpPath).toBe('C:/pg/pg_dump.exe');

    // --- vault credential: secret round-trips + re-linked to the remapped DB connection
    const cred = dst.vaultCredentialsRepo.listByClient(rivera.id)[0];
    expect(readCredentialSecret(dst.vaultSecretStore, cred.secretBlobRef!)).toEqual({ password: 'db-pw-1', notes: 'prod' });
    expect(cred.linkedDatabaseConnectionId).toBe(dbc.id);
    expect(cred.operationalSyncState).toBe('ok');

    // --- URL link remapped, sensitive note body recovered on the other client
    const url = dst.vaultUrlsRepo.listByClient(rivera.id)[0];
    expect(url.linkedCredentialId).toBe(cred.id);
    const carena = dst.clientsRepo.getByName('Carena')!;
    const note = dst.vaultItemsRepo.listByClient(carena.id, 'note')[0];
    expect(dst.vaultSecretStore.get(note.bodyBlobRef!)).toBe('root pw hunter2');
  });

  it('warns about localBasePath / repo_path that do not exist on the destination machine', () => {
    const src = createTestContext();
    seedFullSource(src); // seeds use D:\B\... paths that do not exist here
    const buf = exportVaultBuffer(backupDeps(src));
    const dst = createTestContext();
    const r = importVaultBuffer(backupDeps(dst), buf, PW);
    expect(r.warnings.some((w) => /local backup folder "D:\\B\\Rivera" does not exist/i.test(w))).toBe(true);
    expect(r.warnings.some((w) => /File-backup repository path "D:\\B\\Rivera\\_restic-repo" does not exist/i.test(w))).toBe(true);
    // ...but everything was still restored
    expect(r.clientsCreated).toBe(2);
    expect(r.fileBackupRepositoriesCreated).toBe(1);
  });

  it('the restored vault opens with the same master password and can take a new backup', () => {
    const src = createTestContext();
    seedFullSource(src);
    const buf = exportVaultBuffer(backupDeps(src));
    const dst = createTestContext();
    importVaultBuffer(backupDeps(dst), buf, PW);
    dst.vaultState.lock();
    expect(() => dst.vaultState.unlock('wrong')).toThrow(WrongMasterPasswordError);
    dst.vaultState.unlock(PW);
    expect(inspectVaultBuffer(exportVaultBuffer(backupDeps(dst))).formatVersion).toBe(2);
  });
});

describe('Arkode Pocket (additive v2 extension)', () => {
  it('a v2 export with Pocket never configured restores fine, with no pocketSync at all (backward compat)', () => {
    const src = createTestContext();
    seedFullSource(src); // never touches Pocket
    const buf = exportVaultBuffer(backupDeps(src));

    const dst = createTestContext();
    const r = importVaultBuffer(backupDeps(dst), buf, PW);

    expect(r.pocketRestored).toBe(false);
    expect(dst.pocketStateRepo.get()).toBeNull();
  });

  it('restores the SAME pocketId + DEK + Drive account, so an already-paired phone keeps working with no re-pairing', () => {
    const src = createTestContext();
    seedFullSource(src);
    src.pocketStateRepo.configure({ driveRemotePath: 'Arkode/Pocket' });
    src.secretStore.set(POCKET_DEK_SECRET_REF, 'ZmFrZS1kZWstMzItYnl0ZXMtYmFzZTY0LWVuY29kZWQhISE='); // fixture-only fake DEK
    src.secretStore.set(POCKET_RCLONE_CONFIG_SECRET_REF, JSON.stringify({ token: '{pocket-oauth-blob}' }));
    src.pocketStateRepo.recordPairing('Pablo Pixel');

    const buf = exportVaultBuffer(backupDeps(src));
    const dst = createTestContext();
    const r = importVaultBuffer(backupDeps(dst), buf, PW);

    expect(r.pocketRestored).toBe(true);
    expect(r.warnings.some((w) => /Pocket/i.test(w))).toBe(false); // no Pocket-specific warning (unrelated path-not-found warnings from seedFullSource are expected)
    const restored = dst.pocketStateRepo.get()!;
    expect(restored.pocketId).toBe(src.pocketStateRepo.get()!.pocketId);
    expect(restored.driveRemotePath).toBe('Arkode/Pocket');
    expect(restored.deviceLabel).toBe('Pablo Pixel');
    expect(dst.secretStore.get(POCKET_DEK_SECRET_REF)).toBe('ZmFrZS1kZWstMzItYnl0ZXMtYmFzZTY0LWVuY29kZWQhISE=');
    expect(JSON.parse(dst.secretStore.get(POCKET_RCLONE_CONFIG_SECRET_REF)!).token).toBe('{pocket-oauth-blob}');
  });

  it('continues the revision sequence instead of resetting to 1 — an already-ahead phone must never see a restored publish as "older"', () => {
    const src = createTestContext();
    seedFullSource(src);
    src.pocketStateRepo.configure({ driveRemotePath: 'Arkode/Pocket' });
    src.secretStore.set(POCKET_DEK_SECRET_REF, 'ZmFrZS1kZWstMzItYnl0ZXMtYmFzZTY0LWVuY29kZWQhISE=');
    // Simulate 57 real confirmed publishes having already happened on the source machine.
    src.db.prepare('UPDATE pocket_state SET last_confirmed_revision = 57 WHERE id = 1').run();

    const buf = exportVaultBuffer(backupDeps(src));
    const dst = createTestContext();
    importVaultBuffer(backupDeps(dst), buf, PW);

    expect(dst.pocketStateRepo.get()!.lastConfirmedRevision).toBe(57);
    expect(dst.pocketStateRepo.get()!.dirty).toBe(false); // nothing is assumed to have changed by the restore itself
    const nextAttempt = dst.pocketStateRepo.beginPublishAttempt();
    expect(nextAttempt.targetRevision).toBe(58); // continues on, never resets to 1
  });

  it('warns (but still restores) when the Pocket DEK or Drive account was missing at export time', () => {
    const src = createTestContext();
    seedFullSource(src);
    src.pocketStateRepo.configure({ driveRemotePath: 'Arkode/Pocket' });
    // Deliberately no DEK, no Drive token set — simulates a Tier-1 secret gone missing.
    const buf = exportVaultBuffer(backupDeps(src));

    const dst = createTestContext();
    const r = importVaultBuffer(backupDeps(dst), buf, PW);

    expect(r.pocketRestored).toBe(true);
    expect(r.warnings.some((w) => /clave de dispositivo/i.test(w))).toBe(true);
    expect(r.warnings.some((w) => /Google Drive/i.test(w))).toBe(true);
    expect(dst.secretStore.get(POCKET_DEK_SECRET_REF)).toBeNull();
  });

  it('a restore into a machine where Pocket is ALREADY configured is refused, matching the vault-wide restore invariant', () => {
    const src = createTestContext();
    seedFullSource(src);
    src.pocketStateRepo.configure({ driveRemotePath: 'Arkode/Pocket' });
    src.secretStore.set(POCKET_DEK_SECRET_REF, 'ZmFrZS1kZWstMzItYnl0ZXMtYmFzZTY0LWVuY29kZWQhISE=');
    const buf = exportVaultBuffer(backupDeps(src));

    // importVaultBuffer itself already refuses a non-fresh vault before
    // touching pocket_state at all — confirms Pocket restore doesn't bypass
    // that guard via some separate path.
    const dst = createTestContext();
    dst.vaultState.init('other', FAST);
    expect(() => importVaultBuffer(backupDeps(dst), buf, PW)).toThrow(/already has a vault/i);
    expect(dst.pocketStateRepo.get()).toBeNull();
  });
});

describe('importVaultBuffer — rejections & partial failure', () => {
  let buf: Buffer;
  beforeEach(() => {
    const src = createTestContext();
    seedFullSource(src);
    buf = exportVaultBuffer(backupDeps(src));
  });

  it('a wrong master password writes nothing (vault + rows + key files all untouched)', () => {
    const dst = createTestContext();
    expect(() => importVaultBuffer(backupDeps(dst), buf, 'nope')).toThrow(WrongMasterPasswordError);
    expect(dst.vaultMetaRepo.get()).toBeNull();
    expect(dst.clientsRepo.listAll()).toHaveLength(0);
    expect(dst.vaultBackupTargetsRepo.list()).toHaveLength(0);
    expect(readdirSync(keysDir).filter((f) => f.endsWith('.key'))).toHaveLength(1); // only the source seed's file
  });

  it('a corrupted payload is rejected', () => {
    const parsed = JSON.parse(buf.toString('utf8'));
    parsed.payload = parsed.payload.slice(0, -4) + 'AAAA';
    parsed.payloadSha256 = createHash('sha256').update(parsed.payload).digest('hex'); // fix checksum so we hit the AEAD tag instead
    const dst = createTestContext();
    expect(() => importVaultBuffer(backupDeps(dst), Buffer.from(JSON.stringify(parsed)), PW)).toThrow();
    expect(dst.vaultMetaRepo.get()).toBeNull();
    expect(dst.transportsRepo.listByClient('x')).toHaveLength(0);
  });

  it('refuses to restore into an already-initialized vault', () => {
    const dst = createTestContext();
    dst.vaultState.init('other', FAST);
    expect(() => importVaultBuffer(backupDeps(dst), buf, PW)).toThrow(/already has a vault/i);
  });

  it('a client name collision fails per-client without aborting the rest', () => {
    const dst = createTestContext();
    dst.clientsRepo.create({ name: 'Rivera', localBasePath: 'D:\\pre' });
    const r = importVaultBuffer(backupDeps(dst), buf, PW);
    expect(r.clientErrors.map((e) => e.name)).toEqual(['Rivera']);
    expect(dst.clientsRepo.getByName('Carena')).not.toBeNull();
    // Rivera's dependents (transports, tasks, repo, credential) are skipped
    expect(r.transportsCreated).toBe(0);
    expect(r.backupTasksCreated).toBe(0);
    expect(r.credentialsCreated).toBe(0);
    // the Carena sensitive note still came back
    const carena = dst.clientsRepo.getByName('Carena')!;
    expect(dst.vaultItemsRepo.listByClient(carena.id, 'note')).toHaveLength(1);
  });
});

describe('importVaultBuffer — v1 backward compatibility', () => {
  it('restores an old vault-only (v1) .arkvault (reduced content, no infra)', () => {
    // Hand-build a v1 file the way pre-v2 arkode wrote it.
    const salt = generateSalt();
    const kek = deriveKek(PW, salt, FAST);
    const dek = generateDek();
    const inner = {
      clients: [{ id: 'c1', name: 'LegacyClient', description: null, localBasePath: 'D:\\L', retentionCount: null, retentionDays: null, isActive: true, createdAt: '', updatedAt: '' }],
      credentials: [{ id: 'k1', clientId: 'c1', name: 'legacy cred', kind: 'generic_login', environment: null, tags: [], host: 'h', port: null, username: 'u', databaseName: null, url: null, secretBlobRef: 'old-ref', linkedTransportId: null, linkedDatabaseConnectionId: null, operationalSyncState: 'none', operationalSyncError: null, favorite: false, description: null, createdAt: '', updatedAt: '', secret: { password: 'legacy-pw' } }],
      urls: [],
      items: [],
    };
    const payload = encryptBytes(Buffer.from(JSON.stringify(inner), 'utf8'), dek).toString('base64');
    const file = {
      magic: 'ARKVAULT', formatVersion: 1, createdAt: new Date().toISOString(), app: 'arkode',
      kdf: 'scrypt', kdfParams: FAST,
      kekSalt: salt.toString('base64'),
      wrappedDek: wrapDek(dek, kek).toString('base64'),
      verifier: buildVerifier(dek).toString('base64'),
      payload, payloadSha256: createHash('sha256').update(payload).digest('hex'),
    };
    const buf = Buffer.from(JSON.stringify(file));

    const dst = createTestContext();
    const r = importVaultBuffer(backupDeps(dst), buf, PW);
    expect(r.formatVersion).toBe(1);
    expect(r.clientsCreated).toBe(1);
    expect(r.credentialsCreated).toBe(1);
    expect(r.transportsCreated).toBe(0);
    const c = dst.clientsRepo.getByName('LegacyClient')!;
    const cred = dst.vaultCredentialsRepo.listByClient(c.id)[0];
    expect(readCredentialSecret(dst.vaultSecretStore, cred.secretBlobRef!)).toEqual({ password: 'legacy-pw' });
  });
});

describe('runVaultBackup — still writes/self-checks/retains at v2', () => {
  let ctx: TestContext;
  beforeEach(() => {
    ctx = createTestContext();
    seedFullSource(ctx);
  });
  const deps = () => backupDeps(ctx);

  it('writes a valid v2 .arkvault, self-checks it, records Success', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'arkvault-bk-'));
    const run = await runVaultBackup(deps(), ctx.vaultBackupTargetsRepo.create({ path: dir }));
    expect(run.status).toBe('Success');
    expect(inspectVaultBuffer(readFileSync(run.filePath!)).formatVersion).toBe(2);
    expect(readdirSync(dir).some((f) => f.endsWith('.tmp'))).toBe(false);
  });

  it('refuses a destination inside the app data directory', async () => {
    const run = await runVaultBackup(deps(), ctx.vaultBackupTargetsRepo.create({ path: join(appDataDir(), 'x') }));
    expect(run.status).toBe('Failed');
    expect(run.errorMessage).toMatch(/data directory/i);
  });
});
