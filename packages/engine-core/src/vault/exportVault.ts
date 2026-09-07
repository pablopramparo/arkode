import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  decryptBytes,
  deriveKek,
  encryptBytes,
  unwrapDek,
  verifierMatches,
  VAULT_FORMAT_VERSION,
  type ScryptParams,
} from './crypto.js';
import { readCredentialSecret, writeCredentialSecret, newCredentialSecretRef } from './credentialBlob.js';
import { WrongMasterPasswordError } from './vaultState.js';
import type { VaultState } from './vaultState.js';
import type { VaultMetaRepo } from './vaultMetaRepo.js';
import type { VaultSecretStore } from './vaultSecretStore.js';
import { keysDir as defaultKeysDir } from '../paths.js';
import { hardenKeyFileAclSync } from '../transports/keyFilePermissions.js';
import type { SecretStore } from '../secrets/types.js';
import type { ClientsRepo } from '../db/repositories/clientsRepo.js';
import type { BackupSetsRepo } from '../db/repositories/backupSetsRepo.js';
import type { TransportsRepo } from '../db/repositories/transportsRepo.js';
import type { DatabaseConnectionsRepo } from '../db/repositories/databaseConnectionsRepo.js';
import type { TasksRepo } from '../db/repositories/tasksRepo.js';
import type { SettingsRepo } from '../db/repositories/settingsRepo.js';
import type { ReplicationTargetsRepo } from '../db/repositories/replicationTargetsRepo.js';
import type { VaultBackupTargetsRepo, VaultBackupTarget } from '../db/repositories/vaultBackupTargetsRepo.js';
import type { FileBackupRepositoriesRepo } from '../fileBackup/db/repositories/fileBackupRepositoriesRepo.js';
import type { FileBackupTasksRepo } from '../fileBackup/db/repositories/fileBackupTasksRepo.js';
import type { VaultCredentialsRepo } from '../db/repositories/vaultCredentialsRepo.js';
import type { VaultUrlsRepo } from '../db/repositories/vaultUrlsRepo.js';
import type { VaultItemsRepo } from '../db/repositories/vaultItemsRepo.js';
import type { VaultCredential, VaultCredentialSecret, VaultItem, VaultUrl } from './types.js';
import type {
  BackupSet,
  BackupTask,
  Client,
  DatabaseConnection,
  Transport,
} from '../types.js';
import type { FileBackupRepository, FileBackupTask } from '../fileBackup/types.js';
import type { ReplicationTarget } from '../replication/types.js';
import type { Database } from 'better-sqlite3';
import type { PocketStateRepo } from '../db/repositories/pocketStateRepo.js';
import { POCKET_DEK_SECRET_REF } from './pocket/pocketDek.js';
import { POCKET_RCLONE_CONFIG_SECRET_REF } from './pocket/pocketDriveAuth.js';

/**
 * .arkvault *container* version.
 *  - v1: the vault-only payload (clients + vault_credentials/urls/items + secrets).
 *  - v2: the full disaster-recovery payload — every operational definition
 *        AND every operational secret (transport/DB passwords + passphrases,
 *        SSH private keys, restic recovery keys, rclone config + crypt
 *        passwords), so a fresh install + this one file + the master
 *        password fully rebuilds Arkode. v1 files still restore (reduced).
 */
export const ARKVAULT_FORMAT_VERSION = 2;
const MAGIC = 'ARKVAULT';

export interface VaultBackupDeps {
  db: Database;
  vaultMetaRepo: VaultMetaRepo;
  vaultState: VaultState;
  vaultSecretStore: VaultSecretStore;
  /** Tier 1 — DPAPI LocalMachine (or a fake in tests). */
  secretStore: SecretStore;
  clientsRepo: ClientsRepo;
  backupSetsRepo: BackupSetsRepo;
  transportsRepo: TransportsRepo;
  databaseConnectionsRepo: DatabaseConnectionsRepo;
  tasksRepo: TasksRepo;
  settingsRepo: SettingsRepo;
  fileBackupRepositoriesRepo: FileBackupRepositoriesRepo;
  fileBackupTasksRepo: FileBackupTasksRepo;
  replicationTargetsRepo: ReplicationTargetsRepo;
  vaultBackupTargetsRepo: VaultBackupTargetsRepo;
  vaultCredentialsRepo: VaultCredentialsRepo;
  vaultUrlsRepo: VaultUrlsRepo;
  vaultItemsRepo: VaultItemsRepo;
  pocketStateRepo: PocketStateRepo;
  /** Test override for where operational key files are written on restore. */
  keysDirOverride?: string;
  /** Test override for the ACL-harden step on restore. */
  hardenKeyFile?: (path: string) => void;
}

// --- payload shapes --------------------------------------------------------
type ExportedTransport = Transport & {
  privateKeyContent: string | null; // base64 of the key file
  passphrase: string | null;
  password: string | null;
};
type ExportedDatabaseConnection = DatabaseConnection & { password: string | null };
type ExportedBackupTask = BackupTask & { remoteDumpDbPassword: string | null };
type ExportedFileBackupRepository = FileBackupRepository & { resticKey: string | null };
type ExportedReplicationTarget = ReplicationTarget & {
  rcloneConfig: string | null; // JSON string (OAuth token blob for drive)
  cryptPassword: string | null;
};
type ExportedVaultBackupTarget = VaultBackupTarget & {
  /** google_drive only: the RcloneDriveConfig JSON (OAuth token) — so DR can resume remote backups with no re-auth. */
  rcloneConfig: string | null;
};

/**
 * Arkode Pocket's state, IF it was ever configured. Carries the Pocket DEK
 * itself (`dek`, base64) and Pocket's own Drive account token
 * (`rcloneConfig`) so a phone already paired against this pocketId keeps
 * working, unattended, after a fresh restore — the whole point of DR is
 * that nothing about "which physical PC" should matter to it. See
 * pocketStateRepo.restore()'s own doc comment for exactly how revision
 * numbering continues correctly instead of resetting to 1 and being
 * rejected by an already-ahead phone. `lastConfirmedRevision` is
 * deliberately the only publish-bookkeeping field carried over — the
 * internal change_seq/published_seq race-detection counters have no
 * meaning across machines and are reset to a clean (non-dirty) baseline on
 * restore instead.
 *
 * IMPORTANT, and inherent to point-in-time recovery, not a bug: restoring
 * an OLDER `.arkvault` restores whatever Pocket DEK was current AT THAT
 * TIME. If a device was revoked (DEK rotated) after that export was taken,
 * restoring it brings back the PRE-revocation key, which the revoked
 * device could open again. There is no way around this within a
 * point-in-time-snapshot model — it is the same "restoring an old backup
 * undoes anything you did after that backup" behavior every other secret
 * in `.arkvault` already has (a restored DB password is likewise whatever
 * was current at export time). The practical mitigation, not enforced by
 * code: take a fresh `.arkvault` backup right after revoking a device (the
 * UI's revoke flow nudges exactly this — see engine-cli's /pocket/revoke).
 */
type ExportedPocketState = {
  pocketId: string;
  enabled: boolean;
  driveRemotePath: string | null;
  driveFileId: string | null;
  deviceLabel: string | null;
  pairedAt: string | null;
  revokedAt: string | null;
  lastConfirmedRevision: number | null;
  /** base64, from Tier-1 SecretStore — null only if the row exists but the secret was somehow missing. */
  dek: string | null;
  /** Pocket's OWN Drive account token JSON — null if never connected. */
  rcloneConfig: string | null;
};

interface InnerPayloadV1 {
  clients: Client[];
  credentials: (VaultCredential & { secret: VaultCredentialSecret })[];
  urls: VaultUrl[];
  items: (VaultItem & { body: string | null })[];
}

interface InnerPayloadV2 extends InnerPayloadV1 {
  version: 2;
  backupSets: BackupSet[];
  transports: ExportedTransport[];
  databaseConnections: ExportedDatabaseConnection[];
  backupTasks: ExportedBackupTask[];
  fileBackupRepositories: ExportedFileBackupRepository[];
  fileBackupTasks: FileBackupTask[];
  replicationTargets: ExportedReplicationTarget[];
  toolRegistries: { postgres: string | null; mysql: string | null; mariadb: string | null };
  /**
   * Additive v2 extension (older readers ignore it, older files read as []).
   * The portable `.arkvault` disaster-recovery destinations themselves —
   * so a fresh restore can resume remote backups automatically. `local_dir`
   * targets restore DISABLED (their path is machine-specific); `google_drive`
   * targets restore ENABLED with their OAuth token, no re-authorization.
   */
  vaultBackupTargets?: ExportedVaultBackupTarget[];
  /** Additive v2 extension, same as vaultBackupTargets above — see ExportedPocketState's own doc comment. Absent entirely if Pocket was never configured. */
  pocketSync?: ExportedPocketState;
}

interface ArkvaultFile {
  magic: string;
  formatVersion: number;
  createdAt: string;
  app: string;
  kdf: string;
  kdfParams: unknown;
  kekSalt: string;
  wrappedDek: string;
  verifier: string;
  payload: string;
  payloadSha256: string;
}

const TOOL_REGISTRY_KEYS = {
  postgres: 'postgresToolRegistry',
  mysql: 'mysqlToolRegistry',
  mariadb: 'mariaDbToolRegistry',
} as const;

/**
 * Serializes the ENTIRE operational state — vault + every infra definition
 * + every operational secret — into one portable, encrypted `.arkvault`
 * buffer. Everything (names, hosts, private keys, restic keys, rclone
 * tokens, crypt passwords) is inside the AES-256-GCM `payload`, so the file
 * reveals nothing without the master password. Requires the vault UNLOCKED.
 */
export function exportVaultBuffer(deps: VaultBackupDeps): Buffer {
  const meta = deps.vaultMetaRepo.get();
  if (!meta) throw new Error('The vault is not initialized — nothing to back up.');

  const t1 = (ref: string | null): string | null => (ref ? deps.secretStore.get(ref) : null);

  const clients = deps.clientsRepo.listAll();

  const backupSets: BackupSet[] = [];
  const transports: ExportedTransport[] = [];
  const databaseConnections: ExportedDatabaseConnection[] = [];
  const backupTasks: ExportedBackupTask[] = [];
  const fileBackupRepositories: ExportedFileBackupRepository[] = [];
  const fileBackupTasks: FileBackupTask[] = [];
  const replicationTargets: ExportedReplicationTarget[] = [];

  for (const client of clients) {
    for (const s of deps.backupSetsRepo.listByClient(client.id, { includeInactive: true })) backupSets.push(s);

    for (const tr of deps.transportsRepo.listByClient(client.id)) {
      let privateKeyContent: string | null = null;
      if (tr.privateKeyPath) {
        try {
          privateKeyContent = readFileSync(tr.privateKeyPath).toString('base64');
        } catch {
          privateKeyContent = null; // broken source install — flagged on restore
        }
      }
      transports.push({
        ...tr,
        privateKeyContent,
        passphrase: t1(tr.passphraseSecretRef),
        password: t1(tr.passwordSecretRef),
      });
    }

    for (const dc of deps.databaseConnectionsRepo.listByClient(client.id)) {
      databaseConnections.push({ ...dc, password: t1(dc.passwordSecretRef) });
    }

    for (const task of deps.tasksRepo.listByClient(client.id)) {
      backupTasks.push({ ...task, remoteDumpDbPassword: t1(task.remoteDumpDbPasswordSecretRef) });
    }

    const fr = deps.fileBackupRepositoriesRepo.getByClientId(client.id);
    if (fr) {
      fileBackupRepositories.push({ ...fr, resticKey: t1(fr.passwordSecretRef) });
      for (const ft of deps.fileBackupTasksRepo.listByClient(client.id)) fileBackupTasks.push(ft);
    }

    for (const rt of deps.replicationTargetsRepo.listByClient(client.id)) {
      replicationTargets.push({
        ...rt,
        rcloneConfig: t1(rt.rcloneConfigSecretRef),
        cryptPassword: t1(rt.cryptPasswordSecretRef),
      });
    }
  }

  // Portable vault-backup destinations are global (not per-client). google_drive
  // targets carry their OAuth token so DR resumes remote backups with no re-auth.
  const vaultBackupTargets: ExportedVaultBackupTarget[] = deps.vaultBackupTargetsRepo.list().map((t) => ({
    ...t,
    rcloneConfig: t.kind === 'google_drive' ? t1(t.rcloneConfigSecretRef) : null,
  }));

  const credentials = deps.vaultCredentialsRepo.listAll().map((c) => ({
    ...c,
    secret: c.secretBlobRef ? readCredentialSecret(deps.vaultSecretStore, c.secretBlobRef) : {},
  }));
  const items = deps.vaultItemsRepo.listAll().map((it) => {
    let body: string | null = it.bodyPlaintext;
    if (it.isSensitive && it.bodyBlobRef) body = deps.vaultSecretStore.get(it.bodyBlobRef);
    return { ...it, body };
  });

  const pocketState = deps.pocketStateRepo.get();
  const pocketSync: ExportedPocketState | undefined = pocketState
    ? {
        pocketId: pocketState.pocketId,
        enabled: pocketState.enabled,
        driveRemotePath: pocketState.driveRemotePath,
        driveFileId: pocketState.driveFileId,
        deviceLabel: pocketState.deviceLabel,
        pairedAt: pocketState.pairedAt,
        revokedAt: pocketState.revokedAt,
        lastConfirmedRevision: pocketState.lastConfirmedRevision,
        dek: t1(POCKET_DEK_SECRET_REF),
        rcloneConfig: t1(POCKET_RCLONE_CONFIG_SECRET_REF),
      }
    : undefined;

  const inner: InnerPayloadV2 = {
    version: 2,
    clients,
    backupSets,
    transports,
    databaseConnections,
    backupTasks,
    fileBackupRepositories,
    fileBackupTasks,
    replicationTargets,
    vaultBackupTargets,
    pocketSync,
    toolRegistries: {
      postgres: deps.settingsRepo.get(TOOL_REGISTRY_KEYS.postgres),
      mysql: deps.settingsRepo.get(TOOL_REGISTRY_KEYS.mysql),
      mariadb: deps.settingsRepo.get(TOOL_REGISTRY_KEYS.mariadb),
    },
    credentials,
    urls: deps.vaultUrlsRepo.listAll(),
    items,
  };

  const payloadBlob = deps.vaultState.withDek((dek) => encryptBytes(Buffer.from(JSON.stringify(inner), 'utf8'), dek));
  const payload = payloadBlob.toString('base64');

  const file: ArkvaultFile = {
    magic: MAGIC,
    formatVersion: ARKVAULT_FORMAT_VERSION,
    createdAt: new Date().toISOString(),
    app: 'arkode',
    kdf: meta.kdf,
    kdfParams: meta.kdfParams,
    kekSalt: meta.kekSalt.toString('base64'),
    wrappedDek: meta.wrappedDek.toString('base64'),
    verifier: meta.verifier.toString('base64'),
    payload,
    payloadSha256: createHash('sha256').update(payload).digest('hex'),
  };
  return Buffer.from(JSON.stringify(file), 'utf8');
}

export class ArkvaultParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArkvaultParseError';
  }
}

function parseArkvault(buf: Buffer): ArkvaultFile {
  let file: ArkvaultFile;
  try {
    file = JSON.parse(buf.toString('utf8')) as ArkvaultFile;
  } catch {
    throw new ArkvaultParseError('Not a valid .arkvault file (bad JSON).');
  }
  if (file.magic !== MAGIC) throw new ArkvaultParseError('Not an .arkvault file (bad magic).');
  if (typeof file.formatVersion !== 'number' || file.formatVersion > ARKVAULT_FORMAT_VERSION) {
    throw new ArkvaultParseError(
      `Unsupported .arkvault format version ${file.formatVersion} (this build understands up to ${ARKVAULT_FORMAT_VERSION}).`
    );
  }
  if (
    typeof file.payload !== 'string' ||
    typeof file.payloadSha256 !== 'string' ||
    typeof file.kekSalt !== 'string' ||
    typeof file.wrappedDek !== 'string' ||
    typeof file.verifier !== 'string'
  ) {
    throw new ArkvaultParseError('The .arkvault file is missing required fields.');
  }
  if (createHash('sha256').update(file.payload).digest('hex') !== file.payloadSha256) {
    throw new ArkvaultParseError('The .arkvault file is corrupted (payload checksum mismatch).');
  }
  return file;
}

/** Read-only preview: validates structure + checksum. Does not need the password. */
export function inspectVaultBuffer(buf: Buffer): { createdAt: string; formatVersion: number } {
  const f = parseArkvault(buf);
  return { createdAt: f.createdAt, formatVersion: f.formatVersion };
}

export interface ImportVaultResult {
  formatVersion: number;
  clientsCreated: number;
  credentialsCreated: number;
  urlsCreated: number;
  itemsCreated: number;
  backupSetsCreated: number;
  transportsCreated: number;
  databaseConnectionsCreated: number;
  backupTasksCreated: number;
  fileBackupRepositoriesCreated: number;
  fileBackupTasksCreated: number;
  replicationTargetsCreated: number;
  vaultBackupTargetsCreated: number;
  toolRegistriesRestored: number;
  pocketRestored: boolean;
  clientErrors: { name: string; error: string }[];
  warnings: string[];
}

function emptyResult(formatVersion: number): ImportVaultResult {
  return {
    formatVersion,
    clientsCreated: 0,
    credentialsCreated: 0,
    urlsCreated: 0,
    itemsCreated: 0,
    backupSetsCreated: 0,
    transportsCreated: 0,
    databaseConnectionsCreated: 0,
    backupTasksCreated: 0,
    fileBackupRepositoriesCreated: 0,
    fileBackupTasksCreated: 0,
    replicationTargetsCreated: 0,
    vaultBackupTargetsCreated: 0,
    toolRegistriesRestored: 0,
    pocketRestored: false,
    clientErrors: [],
    warnings: [],
  };
}

/**
 * Restores an `.arkvault` into a FRESH (uninitialized) vault on this
 * machine: adopts the file's key material (same master password), then
 * re-creates every project / connection / task / repo / replication target
 * / credential — regenerating all machine-bound material from the payload
 * (DPAPI Tier-1 secrets, ACL-hardened SSH key files, id remapping). A
 * client whose name already exists fails per-client without aborting the
 * rest. Leaves the vault unlocked. Nothing needed to decrypt or use
 * existing backups depends on the original machine.
 */
export function importVaultBuffer(deps: VaultBackupDeps, buf: Buffer, password: string): ImportVaultResult {
  if (deps.vaultMetaRepo.get()) {
    throw new Error('This machine already has a vault. Restore is only supported into a fresh install.');
  }
  const file = parseArkvault(buf);

  const kekSalt = Buffer.from(file.kekSalt, 'base64');
  const wrappedDek = Buffer.from(file.wrappedDek, 'base64');
  const verifier = Buffer.from(file.verifier, 'base64');
  const kdfParams = file.kdfParams as ScryptParams;

  // Validate the password BEFORE writing anything (meta, rows or key files).
  const kek = deriveKek(password, kekSalt, kdfParams);
  let dek: Buffer;
  try {
    dek = unwrapDek(wrappedDek, kek);
  } catch {
    throw new WrongMasterPasswordError();
  }
  if (!verifierMatches(verifier, dek)) throw new WrongMasterPasswordError();

  const inner = JSON.parse(decryptBytes(Buffer.from(file.payload, 'base64'), dek).toString('utf8')) as
    | InnerPayloadV1
    | InnerPayloadV2;
  const isV2 = file.formatVersion >= 2 && (inner as InnerPayloadV2).version === 2;
  const result = emptyResult(file.formatVersion);

  const keysDir = deps.keysDirOverride ?? defaultKeysDir();
  const harden = deps.hardenKeyFile ?? hardenKeyFileAclSync;

  // Pre-transaction: materialize SSH key files (FS is not transactional).
  // exportTransportId -> written key path.
  const writtenKeyPaths: string[] = [];
  const transportKeyPath = new Map<string, string>();
  if (isV2) {
    mkdirSync(keysDir, { recursive: true });
    for (const tr of (inner as InnerPayloadV2).transports) {
      if (!tr.privateKeyContent) continue;
      const dest = join(keysDir, `${randomUUID()}.key`);
      const tmp = `${dest}.tmp`;
      try {
        writeFileSync(tmp, Buffer.from(tr.privateKeyContent, 'base64'), { mode: 0o600 });
        renameSync(tmp, dest);
        harden(dest);
      } catch (err) {
        for (const f of [tmp, dest]) {
          try {
            if (existsSync(f)) rmSync(f, { force: true });
          } catch {
            /* best-effort */
          }
        }
        for (const w of writtenKeyPaths) {
          try {
            rmSync(w, { force: true });
          } catch {
            /* best-effort */
          }
        }
        throw err;
      }
      writtenKeyPaths.push(dest);
      transportKeyPath.set(tr.id, dest);
    }
  }

  try {
    deps.db.transaction(() => {
      deps.vaultMetaRepo.create({
        formatVersion: VAULT_FORMAT_VERSION,
        kdf: file.kdf,
        kdfParams,
        kekSalt,
        wrappedDek,
        verifier,
      });
      deps.vaultState.unlock(password);

      const clientIdMap = new Map<string, string>();
      const credIdMap = new Map<string, string>();
      const backupSetIdMap = new Map<string, string>();
      const transportIdMap = new Map<string, string>();
      const dbConnIdMap = new Map<string, string>();
      const fileRepoIdMap = new Map<string, string>();

      // 1. clients
      for (const client of inner.clients) {
        try {
          const created = deps.clientsRepo.create({
            name: client.name,
            description: client.description ?? null,
            localBasePath: client.localBasePath,
            retentionCount: client.retentionCount ?? null,
            retentionDays: client.retentionDays ?? null,
          });
          clientIdMap.set(client.id, created.id);
          result.clientsCreated++;
          if (client.localBasePath && !existsSync(client.localBasePath)) {
            result.warnings.push(
              `Client "${client.name}": local backup folder "${client.localBasePath}" does not exist on this machine — review the path.`
            );
          }
        } catch (err) {
          result.clientErrors.push({ name: client.name, error: err instanceof Error ? err.message : String(err) });
        }
      }

      if (isV2) {
        const v2 = inner as InnerPayloadV2;

        // 2. backup sets
        for (const s of v2.backupSets) {
          const cid = clientIdMap.get(s.clientId);
          if (!cid) continue;
          const created = deps.backupSetsRepo.create({ clientId: cid, name: s.name });
          backupSetIdMap.set(s.id, created.id);
          if (!s.isActive) deps.backupSetsRepo.deactivate(created.id);
          result.backupSetsCreated++;
        }

        // 3. transports
        for (const tr of v2.transports) {
          const cid = clientIdMap.get(tr.clientId);
          if (!cid) continue;
          const keyPath = transportKeyPath.get(tr.id) ?? null;
          if ((tr.type === 'sftp' || tr.type === 'ssh') && !keyPath) {
            result.warnings.push(
              `Transport "${tr.name}" (${tr.type}) had no readable private key in the backup — skipped. Recreate it manually.`
            );
            continue;
          }
          const passphraseRef = tr.passphrase
            ? (() => {
                const ref = `transport:passphrase:${randomUUID()}`;
                deps.secretStore.set(ref, tr.passphrase!);
                return ref;
              })()
            : null;
          const passwordRef = tr.password
            ? (() => {
                const ref = `transport:password:${randomUUID()}`;
                deps.secretStore.set(ref, tr.password!);
                return ref;
              })()
            : null;
          let created: Transport;
          if (tr.type === 'ftp') {
            created = deps.transportsRepo.createFtp({
              clientId: cid,
              name: tr.name,
              host: tr.host,
              port: tr.port,
              username: tr.username,
              passwordSecretRef: passwordRef,
            });
          } else if (tr.type === 'sftp') {
            created = deps.transportsRepo.createSftp({
              clientId: cid,
              name: tr.name,
              host: tr.host,
              port: tr.port,
              username: tr.username,
              privateKeyPath: keyPath!,
              passphraseSecretRef: passphraseRef,
              knownHostFingerprint: tr.knownHostFingerprint ?? null,
            });
          } else {
            created = deps.transportsRepo.createSsh({
              clientId: cid,
              name: tr.name,
              host: tr.host,
              port: tr.port,
              username: tr.username,
              privateKeyPath: keyPath!,
              passphraseSecretRef: passphraseRef,
              knownHostFingerprint: tr.knownHostFingerprint ?? null,
            });
          }
          transportIdMap.set(tr.id, created.id);
          if (!tr.isActive) deps.transportsRepo.deactivate(created.id);
          result.transportsCreated++;
        }

        // 4. database connections
        for (const dc of v2.databaseConnections) {
          const cid = clientIdMap.get(dc.clientId);
          if (!cid) continue;
          let pwdRef: string | null = null;
          if (dc.password) {
            pwdRef = `databaseConnection:password:${randomUUID()}`;
            deps.secretStore.set(pwdRef, dc.password);
          }
          const created = deps.databaseConnectionsRepo.create({
            clientId: cid,
            name: dc.name,
            engine: dc.engine,
            host: dc.host,
            port: dc.port,
            databaseName: dc.databaseName,
            username: dc.username,
            passwordSecretRef: pwdRef,
            sslMode: dc.sslMode ?? null,
          });
          dbConnIdMap.set(dc.id, created.id);
          if (!dc.isActive) deps.databaseConnectionsRepo.deactivate(created.id);
          result.databaseConnectionsCreated++;
        }

        // 5. backup tasks
        for (const task of v2.backupTasks) {
          const cid = clientIdMap.get(task.clientId);
          if (!cid) continue;
          const setId = task.backupSetId ? (backupSetIdMap.get(task.backupSetId) ?? null) : null;
          let createdId: string;
          try {
            if (task.strategy === 'fetch_existing') {
              const tid = task.transportId ? transportIdMap.get(task.transportId) : undefined;
              if (!tid) {
                result.warnings.push(`Backup task "${task.name}" skipped — its transport wasn't restored.`);
                continue;
              }
              createdId = deps.tasksRepo.createFetchExisting({
                clientId: cid,
                transportId: tid,
                name: task.name,
                dbEngine: task.dbEngine,
                remotePath: task.remotePath ?? '',
                remoteFilePattern: task.remoteFilePattern ?? null,
                retentionCount: task.retentionCount ?? null,
                retentionDays: task.retentionDays ?? null,
                backupSetId: setId,
              }).id;
            } else if (task.strategy === 'remote_dump') {
              const tid = task.transportId ? transportIdMap.get(task.transportId) : undefined;
              if (!tid) {
                result.warnings.push(`Backup task "${task.name}" skipped — its transport wasn't restored.`);
                continue;
              }
              let dockerPwdRef: string | null = null;
              if (task.remoteDumpDbPassword) {
                dockerPwdRef = `task:remoteDumpDbPassword:${randomUUID()}`;
                deps.secretStore.set(dockerPwdRef, task.remoteDumpDbPassword);
              }
              createdId = deps.tasksRepo.createRemoteDump({
                clientId: cid,
                transportId: tid,
                name: task.name,
                dbEngine: task.dbEngine,
                remoteCommand: task.remoteCommand ?? undefined,
                remoteOutputPathTemplate: task.remoteOutputPathTemplate ?? '',
                remoteCleanup: task.remoteCleanup,
                retentionCount: task.retentionCount ?? null,
                retentionDays: task.retentionDays ?? null,
                backupSetId: setId,
                remoteDumpExecMode: task.remoteDumpExecMode,
                dockerContainer: task.dockerContainer ?? undefined,
                remoteDumpDatabase: task.remoteDumpDatabase ?? undefined,
                remoteDumpDbUser: task.remoteDumpDbUser ?? undefined,
                remoteDumpDbPasswordSecretRef: dockerPwdRef,
              }).id;
            } else {
              const dcid = task.databaseConnectionId ? dbConnIdMap.get(task.databaseConnectionId) : undefined;
              if (!dcid) {
                result.warnings.push(`Backup task "${task.name}" skipped — its database connection wasn't restored.`);
                continue;
              }
              createdId = deps.tasksRepo.createDirectDump({
                clientId: cid,
                databaseConnectionId: dcid,
                name: task.name,
                dbEngine: task.dbEngine,
                retentionCount: task.retentionCount ?? null,
                retentionDays: task.retentionDays ?? null,
                backupSetId: setId,
              }).id;
            }
          } catch (err) {
            result.warnings.push(`Backup task "${task.name}" could not be restored: ${err instanceof Error ? err.message : String(err)}`);
            continue;
          }
          if (task.scheduleTime) {
            deps.tasksRepo.setSchedule(createdId, {
              scheduleTime: task.scheduleTime,
              scheduleEnabled: task.scheduleEnabled,
              scheduleFrequency: task.scheduleFrequency,
              scheduleDaysOfWeek: task.scheduleDaysOfWeek,
              scheduleDayOfMonth: task.scheduleDayOfMonth,
            });
          }
          if (!task.isActive) deps.tasksRepo.deactivate(createdId);
          result.backupTasksCreated++;
        }

        // 6. file-backup repositories
        for (const fr of v2.fileBackupRepositories) {
          const cid = clientIdMap.get(fr.clientId);
          if (!cid) continue;
          if (!fr.resticKey) {
            result.warnings.push(`File-backup repository for "${fr.repoPath}" had no restic key in the backup — skipped.`);
            continue;
          }
          const ref = `file-backup-repository:${cid}:password`;
          deps.secretStore.set(ref, fr.resticKey);
          const created = deps.fileBackupRepositoriesRepo.create({ clientId: cid, repoPath: fr.repoPath, passwordSecretRef: ref });
          if (fr.initializedAt) deps.fileBackupRepositoriesRepo.markInitialized(created.id, fr.resticRepoId ?? null);
          fileRepoIdMap.set(fr.id, created.id);
          result.fileBackupRepositoriesCreated++;
          if (fr.repoPath && !existsSync(fr.repoPath)) {
            result.warnings.push(
              `File-backup repository path "${fr.repoPath}" does not exist on this machine — review the path (its restic recovery key was restored).`
            );
          }
        }

        // 7. file-backup tasks
        for (const ft of v2.fileBackupTasks) {
          const cid = clientIdMap.get(ft.clientId);
          const rid = fileRepoIdMap.get(ft.repositoryId);
          if (!cid || !rid) continue;
          let createdId: string;
          if (ft.sourceKind === 'local_folder') {
            createdId = deps.fileBackupTasksRepo.createLocalFolder({
              clientId: cid,
              repositoryId: rid,
              name: ft.name,
              sourcePath: ft.sourcePath ?? '',
              retentionCount: ft.retentionCount ?? null,
              retentionDays: ft.retentionDays ?? null,
              backupSetId: ft.backupSetId ? (backupSetIdMap.get(ft.backupSetId) ?? null) : null,
            }).id;
          } else {
            const tid = ft.transportId ? transportIdMap.get(ft.transportId) : undefined;
            if (!tid) {
              result.warnings.push(`File-backup task "${ft.name}" skipped — its transport wasn't restored.`);
              continue;
            }
            createdId = deps.fileBackupTasksRepo.createRemoteFolder({
              clientId: cid,
              repositoryId: rid,
              name: ft.name,
              transportId: tid,
              remoteSourcePath: ft.remoteSourcePath ?? '',
              retentionCount: ft.retentionCount ?? null,
              retentionDays: ft.retentionDays ?? null,
              backupSetId: ft.backupSetId ? (backupSetIdMap.get(ft.backupSetId) ?? null) : null,
            }).id;
          }
          if (ft.scheduleTime) {
            deps.fileBackupTasksRepo.setSchedule(createdId, {
              scheduleTime: ft.scheduleTime,
              scheduleEnabled: ft.scheduleEnabled,
              scheduleFrequency: ft.scheduleFrequency,
              scheduleDaysOfWeek: ft.scheduleDaysOfWeek,
              scheduleDayOfMonth: ft.scheduleDayOfMonth,
            });
          }
          if (!ft.isActive) deps.fileBackupTasksRepo.deactivate(createdId);
          result.fileBackupTasksCreated++;
        }

        // 8. replication targets
        for (const rt of v2.replicationTargets) {
          const cid = clientIdMap.get(rt.clientId);
          if (!cid) continue;
          let rcloneConfigRef: string | undefined;
          let transportId: string | undefined;
          if (rt.provider === 'rclone_drive') {
            if (!rt.rcloneConfig) {
              result.warnings.push(`Replication target (${rt.content}) skipped — its rclone config wasn't in the backup.`);
              continue;
            }
            rcloneConfigRef = `replication:${cid}:${rt.content}:rclone-config`;
            deps.secretStore.set(rcloneConfigRef, rt.rcloneConfig);
          } else {
            const tid = rt.transportId ? transportIdMap.get(rt.transportId) : undefined;
            if (!tid) {
              result.warnings.push(`Replication target (${rt.content}) skipped — its transport wasn't restored.`);
              continue;
            }
            transportId = tid;
          }
          let cryptRef: string | null = null;
          if (rt.encryptWithCrypt && rt.cryptPassword) {
            cryptRef = `replication:${cid}:${rt.content}:crypt-password`;
            deps.secretStore.set(cryptRef, rt.cryptPassword);
          }
          const created = deps.replicationTargetsRepo.create({
            clientId: cid,
            content: rt.content,
            provider: rt.provider,
            remotePath: rt.remotePath,
            rcloneConfigSecretRef: rcloneConfigRef,
            transportId,
            encryptWithCrypt: rt.encryptWithCrypt,
            cryptPasswordSecretRef: cryptRef,
          });
          if (rt.sftpHostKey && rt.sftpHostKeyFingerprint) {
            deps.replicationTargetsRepo.setSftpHostKey(created.id, rt.sftpHostKey, rt.sftpHostKeyFingerprint);
          }
          if (!rt.enabled) deps.replicationTargetsRepo.update(created.id, { enabled: false });
          result.replicationTargetsCreated++;
        }

        // 8b. portable vault-backup destinations (additive v2 extension)
        for (const vbt of v2.vaultBackupTargets ?? []) {
          if (vbt.kind === 'google_drive') {
            if (!vbt.remotePath) continue;
            const created = deps.vaultBackupTargetsRepo.createGoogleDrive({
              remotePath: vbt.remotePath,
              label: vbt.label,
              retentionCount: vbt.retentionCount,
              enabled: vbt.enabled,
            });
            if (vbt.rcloneConfig && created.rcloneConfigSecretRef) {
              deps.secretStore.set(created.rcloneConfigSecretRef, vbt.rcloneConfig);
            } else {
              result.warnings.push(
                `Google Drive vault-backup destination "${vbt.remotePath}" was restored but its account token was not in the backup — reconnect Google Drive.`
              );
            }
            result.vaultBackupTargetsCreated++;
          } else if (vbt.path) {
            // A local path is machine-specific — restore it DISABLED so the
            // user reviews/re-points it before it runs on the new machine.
            deps.vaultBackupTargetsRepo.create({
              path: vbt.path,
              retentionCount: vbt.retentionCount,
              enabled: false,
            });
            result.vaultBackupTargetsCreated++;
            result.warnings.push(
              `Local vault-backup destination "${vbt.path}" was restored DISABLED — check the path exists on this machine, then re-enable it.`
            );
          }
        }

        // 9. tool registries
        for (const [engine, key] of Object.entries(TOOL_REGISTRY_KEYS)) {
          const json = v2.toolRegistries[engine as keyof typeof v2.toolRegistries];
          if (json) {
            deps.settingsRepo.set(key, json);
            result.toolRegistriesRestored++;
          }
        }

      }

      // 10. vault credentials (all versions)
      for (const cred of inner.credentials) {
        const cid = clientIdMap.get(cred.clientId);
        if (!cid) continue;
        const ref = newCredentialSecretRef();
        writeCredentialSecret(deps.vaultSecretStore, ref, cred.secret ?? {});
        const created = deps.vaultCredentialsRepo.create({
          clientId: cid,
          name: cred.name,
          kind: cred.kind,
          environment: cred.environment,
          tags: cred.tags,
          host: cred.host,
          port: cred.port,
          username: cred.username,
          databaseName: cred.databaseName,
          url: cred.url,
          secretBlobRef: ref,
          favorite: cred.favorite,
          description: cred.description,
        });
        credIdMap.set(cred.id, created.id);
        // Re-link to the restored transport / DB connection (both restored with their own Tier-1 secrets already).
        const linkedTransportId = cred.linkedTransportId ? transportIdMap.get(cred.linkedTransportId) : undefined;
        const linkedDbConnId = cred.linkedDatabaseConnectionId ? dbConnIdMap.get(cred.linkedDatabaseConnectionId) : undefined;
        if (linkedTransportId || linkedDbConnId) {
          deps.vaultCredentialsRepo.setLink(created.id, {
            linkedTransportId: linkedTransportId ?? null,
            linkedDatabaseConnectionId: linkedDbConnId ?? null,
          });
          deps.vaultCredentialsRepo.setOperationalSyncState(created.id, 'ok', null);
        }
        result.credentialsCreated++;
      }

      // 11. URLs
      for (const u of inner.urls) {
        const cid = clientIdMap.get(u.clientId);
        if (!cid) continue;
        deps.vaultUrlsRepo.create({
          clientId: cid,
          name: u.name,
          url: u.url,
          environment: u.environment,
          tags: u.tags,
          linkedCredentialId: u.linkedCredentialId ? (credIdMap.get(u.linkedCredentialId) ?? null) : null,
          favorite: u.favorite,
          description: u.description,
        });
        result.urlsCreated++;
      }

      // 12. items
      for (const it of inner.items) {
        const cid = clientIdMap.get(it.clientId);
        if (!cid) continue;
        let bodyBlobRef: string | null = null;
        let bodyPlaintext: string | null = null;
        if (it.isSensitive && it.body != null) {
          bodyBlobRef = `vault:item:${randomUUID()}`;
          deps.vaultSecretStore.set(bodyBlobRef, it.body);
        } else {
          bodyPlaintext = it.body ?? null;
        }
        deps.vaultItemsRepo.create({
          clientId: cid,
          type: it.type,
          title: it.title,
          environment: it.environment,
          tags: it.tags,
          description: it.description,
          favorite: it.favorite,
          isSensitive: it.isSensitive,
          bodyPlaintext,
          bodyBlobRef,
          metadata: it.metadata,
        });
        result.itemsCreated++;
      }

      // 13. Arkode Pocket (additive v2 extension) — deliberately LAST, after
      // every client/credential/URL is already restored: pocket_state's own
      // dirty-tracking triggers (see its migration) fire on those inserts,
      // and creating pocket_state before them would immediately re-dirty
      // the clean baseline restore() just established. Restores the SAME
      // pocketId + DEK so an already-paired phone keeps working with no
      // re-pairing, and continues the revision sequence it already trusts
      // (see pocketStateRepo.restore()'s own doc comment for why that
      // specifically matters). Absent entirely on a v1 file, or if Pocket
      // was never configured on the source machine.
      if (isV2 && (inner as InnerPayloadV2).pocketSync) {
        const ps = (inner as InnerPayloadV2).pocketSync!;
        deps.pocketStateRepo.restore({
          pocketId: ps.pocketId,
          driveRemotePath: ps.driveRemotePath,
          driveFileId: ps.driveFileId,
          enabled: ps.enabled,
          deviceLabel: ps.deviceLabel,
          pairedAt: ps.pairedAt,
          revokedAt: ps.revokedAt,
          lastConfirmedRevision: ps.lastConfirmedRevision,
        });
        if (ps.dek) {
          deps.secretStore.set(POCKET_DEK_SECRET_REF, ps.dek);
        } else {
          result.warnings.push(
            'Arkode Pocket estaba configurado pero su clave de dispositivo no estaba en esta copia — cualquier teléfono ya vinculado necesitará un nuevo código de vinculación.'
          );
        }
        if (ps.rcloneConfig) {
          deps.secretStore.set(POCKET_RCLONE_CONFIG_SECRET_REF, ps.rcloneConfig);
        } else {
          result.warnings.push('Arkode Pocket estaba configurado pero su cuenta de Google Drive no estaba conectada en esta copia — reconectala en Configuración → Arkode Pocket.');
        }
        result.pocketRestored = true;
      }
    })();
  } catch (err) {
    // Roll everything back: the SQLite transaction already reverted; also
    // drop the pre-written key files and re-lock so the vault is truly fresh.
    for (const w of writtenKeyPaths) {
      try {
        rmSync(w, { force: true });
      } catch {
        /* best-effort */
      }
    }
    try {
      deps.vaultState.lock();
    } catch {
      /* best-effort */
    }
    throw err;
  }

  return result;
}
