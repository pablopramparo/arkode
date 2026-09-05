import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { keysDir } from '../paths.js';
import { hardenKeyFileAclSync } from '../transports/keyFilePermissions.js';
import type { SecretStore } from '../secrets/types.js';
import type { TransportsRepo } from '../db/repositories/transportsRepo.js';
import type { DatabaseConnectionsRepo } from '../db/repositories/databaseConnectionsRepo.js';
import type { VaultCredentialsRepo } from '../db/repositories/vaultCredentialsRepo.js';
import type { VaultSecretStore } from './vaultSecretStore.js';
import { readCredentialSecret, writeCredentialSecret } from './credentialBlob.js';
import { linkTargetForKind, type VaultCredential, type VaultCredentialSecret } from './types.js';

export interface SyncOperationalCopyDeps {
  db: Database;
  vaultCredentialsRepo: VaultCredentialsRepo;
  vaultSecretStore: VaultSecretStore;
  transportsRepo: TransportsRepo;
  databaseConnectionsRepo: DatabaseConnectionsRepo;
  /** Tier 1 — DPAPI LocalMachine (or a fake in tests). */
  secretStore: SecretStore;
  /** Test override for where operational key files are written. */
  keysDirOverride?: string;
  /** Test override for the ACL-harden step. */
  hardenKeyFile?: (path: string) => void;
}

export interface SyncOperationalCopyResult {
  ok: boolean;
  state: VaultCredential['operationalSyncState'];
  message?: string;
}

export interface SyncOperationalCopyOptions {
  useForBackups: boolean;
  /** Fresh plaintext, when the caller has it (create/edit). Re-written into the blob atomically with the Tier-1 copy. */
  secret?: VaultCredentialSecret;
}

function keysDirOf(deps: SyncOperationalCopyDeps): string {
  return deps.keysDirOverride ?? keysDir();
}

/**
 * Writes + ACL-hardens an operational key file from PEM/OpenSSH text.
 * FS-only, runs before the DB transaction. Cleans up its own partial output
 * if any step throws, so a failure leaves the keys dir exactly as it found it.
 */
function materializeKeyFile(deps: SyncOperationalCopyDeps, privateKey: string): string {
  const dir = keysDirOf(deps);
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, `${randomUUID()}.key`);
  const tmp = `${dest}.tmp`;
  try {
    writeFileSync(tmp, privateKey, { mode: 0o600 });
    renameSync(tmp, dest);
    (deps.hardenKeyFile ?? hardenKeyFileAclSync)(dest);
    return dest;
  } catch (err) {
    for (const f of [tmp, dest]) {
      try {
        if (existsSync(f)) rmSync(f, { force: true });
      } catch {
        /* best-effort */
      }
    }
    throw err;
  }
}

/** Deletes a key file only if no transport still points at it. Best-effort. */
function deleteKeyFileIfUnreferenced(deps: SyncOperationalCopyDeps, keyPath: string | null): void {
  if (!keyPath) return;
  try {
    const stillUsed = deps.db
      .prepare('SELECT 1 FROM transports WHERE private_key_path = ? LIMIT 1')
      .get(keyPath);
    if (!stillUsed && existsSync(keyPath)) rmSync(keyPath, { force: true });
  } catch {
    /* best-effort — a stale key file is harmless, a lost one is recoverable from the vault */
  }
}

/**
 * The synchronous DB half of the bridge — creates/updates the linked
 * transport|database_connection row, writes the Tier-1 DPAPI secret, sets
 * the link, and stamps operational_sync_state='ok'. Throws on any problem so
 * the caller's `db.transaction()` rolls the whole thing back. Never touches
 * the filesystem.
 */
export function applyOperationalCopy(
  deps: SyncOperationalCopyDeps,
  credential: VaultCredential,
  secret: VaultCredentialSecret,
  keyPath: string | null
): void {
  const target = linkTargetForKind(credential.kind);
  if (target === null) {
    throw new Error(`A "${credential.kind}" credential cannot be used for backups.`);
  }

  if (target === 'database_connection') {
    if (!credential.host || !credential.username || !credential.databaseName || !credential.port) {
      throw new Error('A database credential needs host, port, database and username to be used for backups.');
    }
    const engine = credential.kind as 'postgres' | 'mysql' | 'mariadb';
    let pwdRef: string | null = null;
    if (secret.password) {
      pwdRef = `vault-operational:dbconn:${credential.id}`;
      deps.secretStore.set(pwdRef, secret.password);
    }
    if (credential.linkedDatabaseConnectionId) {
      const existing = deps.databaseConnectionsRepo.getById(credential.linkedDatabaseConnectionId);
      if (!existing) throw new Error('The linked database connection no longer exists.');
      deps.databaseConnectionsRepo.update(existing.id, {
        host: credential.host,
        port: credential.port,
        databaseName: credential.databaseName,
        username: credential.username,
        ...(pwdRef ? { passwordSecretRef: pwdRef } : {}),
      });
    } else {
      const created = deps.databaseConnectionsRepo.create({
        clientId: credential.clientId,
        name: `${credential.name} (bóveda)`,
        engine,
        host: credential.host,
        port: credential.port,
        databaseName: credential.databaseName,
        username: credential.username,
        passwordSecretRef: pwdRef,
      });
      deps.vaultCredentialsRepo.setLink(credential.id, { linkedDatabaseConnectionId: created.id });
    }
  } else {
    // transport: ssh | sftp | ftp
    if (!credential.host || !credential.username) {
      throw new Error('A connection credential needs a host and username to be used for backups.');
    }
    const isKeyed = credential.kind === 'ssh' || credential.kind === 'sftp' || credential.kind === 'ssh_key';
    const type: 'ssh' | 'sftp' | 'ftp' =
      credential.kind === 'ftp' ? 'ftp' : credential.kind === 'sftp' ? 'sftp' : 'ssh';

    let existing = credential.linkedTransportId
      ? deps.transportsRepo.getById(credential.linkedTransportId)
      : null;

    const effectiveKeyPath = keyPath ?? existing?.privateKeyPath ?? null;
    if (isKeyed && !effectiveKeyPath) {
      throw new Error('An SSH/SFTP credential needs a private key to be used for backups.');
    }

    // Passphrase (ssh/sftp) or password (ftp) -> Tier 1.
    let passphraseRef = existing?.passphraseSecretRef ?? null;
    let passwordRef = existing?.passwordSecretRef ?? null;
    if (isKeyed) {
      if (secret.privateKeyPassphrase) {
        passphraseRef = passphraseRef ?? `vault-operational:transport-passphrase:${credential.id}`;
        deps.secretStore.set(passphraseRef, secret.privateKeyPassphrase);
      } else if (passphraseRef) {
        deps.secretStore.delete(passphraseRef);
        passphraseRef = null;
      }
    } else if (secret.password) {
      passwordRef = passwordRef ?? `vault-operational:transport-password:${credential.id}`;
      deps.secretStore.set(passwordRef, secret.password);
    }

    if (existing) {
      deps.transportsRepo.update(existing.id, {
        host: credential.host,
        port: credential.port ?? existing.port,
        username: credential.username,
        ...(isKeyed && effectiveKeyPath ? { privateKeyPath: effectiveKeyPath } : {}),
        passphraseSecretRef: passphraseRef,
        passwordSecretRef: passwordRef,
      });
    } else {
      let created;
      if (type === 'ftp') {
        created = deps.transportsRepo.createFtp({
          clientId: credential.clientId,
          name: `${credential.name} (bóveda)`,
          host: credential.host,
          port: credential.port ?? 21,
          username: credential.username,
          passwordSecretRef: passwordRef,
        });
      } else if (type === 'sftp') {
        created = deps.transportsRepo.createSftp({
          clientId: credential.clientId,
          name: `${credential.name} (bóveda)`,
          host: credential.host,
          port: credential.port ?? 22,
          username: credential.username,
          privateKeyPath: effectiveKeyPath!,
          passphraseSecretRef: passphraseRef,
        });
      } else {
        created = deps.transportsRepo.createSsh({
          clientId: credential.clientId,
          name: `${credential.name} (bóveda)`,
          host: credential.host,
          port: credential.port ?? 22,
          username: credential.username,
          privateKeyPath: effectiveKeyPath!,
          passphraseSecretRef: passphraseRef,
        });
      }
      existing = created;
      deps.vaultCredentialsRepo.setLink(credential.id, { linkedTransportId: created.id });
    }
  }

  deps.vaultCredentialsRepo.setOperationalSyncState(credential.id, 'ok', null);
}

/** Clears the link + Tier-1 state; leaves the transport/dbconn row and its DPAPI secret intact so the backup job keeps working. */
function unlinkOperationalCopy(deps: SyncOperationalCopyDeps, credential: VaultCredential): SyncOperationalCopyResult {
  const oldKeyPath =
    credential.linkedTransportId
      ? (deps.transportsRepo.getById(credential.linkedTransportId)?.privateKeyPath ?? null)
      : null;
  deps.db.transaction(() => {
    deps.vaultCredentialsRepo.setLink(credential.id, { linkedTransportId: null, linkedDatabaseConnectionId: null });
    deps.vaultCredentialsRepo.setOperationalSyncState(credential.id, 'none', null);
  })();
  // The transport row is intentionally kept; only drop the key file if it is now orphaned.
  void oldKeyPath;
  return { ok: true, state: 'none' };
}

/**
 * Top-level bridge: FS key materialization (pre), then all DB mutations in
 * ONE `db.transaction()` (blob re-write + connection row + Tier-1 DPAPI
 * secret + link + state). On any failure the transaction rolls back, the
 * freshly-written key file is removed, `operational_sync_state` is set to
 * 'error', and `{ ok: false }` is returned — never a silent success.
 * VaultLockedError propagates (the caller maps it to 423 "unlock first").
 */
export function syncOperationalCopy(
  deps: SyncOperationalCopyDeps,
  credentialId: string,
  opts: SyncOperationalCopyOptions
): SyncOperationalCopyResult {
  const credential = deps.vaultCredentialsRepo.getById(credentialId);
  if (!credential) throw new Error(`Vault credential ${credentialId} not found.`);

  if (!opts.useForBackups) {
    return unlinkOperationalCopy(deps, credential);
  }

  if (linkTargetForKind(credential.kind) === null) {
    return { ok: false, state: 'error', message: `A "${credential.kind}" credential cannot be used for backups.` };
  }

  // Resolve the plaintext secret: caller-supplied (fresh) or from the blob.
  const secretFromCaller = opts.secret !== undefined;
  const secret: VaultCredentialSecret = secretFromCaller
    ? opts.secret!
    : credential.secretBlobRef
      ? readCredentialSecret(deps.vaultSecretStore, credential.secretBlobRef) // throws VaultLockedError if locked
      : {};

  const oldKeyPath = credential.linkedTransportId
    ? (deps.transportsRepo.getById(credential.linkedTransportId)?.privateKeyPath ?? null)
    : null;

  let newKeyPath: string | null = null;
  try {
    const isKeyed = credential.kind === 'ssh' || credential.kind === 'sftp' || credential.kind === 'ssh_key';
    if (isKeyed && secret.privateKey) {
      newKeyPath = materializeKeyFile(deps, secret.privateKey);
    }

    deps.db.transaction(() => {
      if (secretFromCaller && credential.secretBlobRef) {
        writeCredentialSecret(deps.vaultSecretStore, credential.secretBlobRef, secret);
      }
      applyOperationalCopy(deps, credential, secret, newKeyPath);
    })();

    // Post-commit: retire a replaced key file.
    if (newKeyPath && oldKeyPath && oldKeyPath !== newKeyPath) {
      deleteKeyFileIfUnreferenced(deps, oldKeyPath);
    }
    return { ok: true, state: 'ok' };
  } catch (err) {
    if (newKeyPath) {
      try {
        rmSync(newKeyPath, { force: true });
      } catch {
        /* best-effort */
      }
    }
    const message = err instanceof Error ? err.message : String(err);
    try {
      deps.vaultCredentialsRepo.setOperationalSyncState(credentialId, 'error', message);
    } catch {
      /* the row may have vanished — nothing more we can do */
    }
    return { ok: false, state: 'error', message };
  }
}

export interface ResyncResult {
  credentialId: string;
  name: string;
  result: SyncOperationalCopyResult;
}

/**
 * Re-derives every linked credential's Tier-1 DPAPI secret + operational key
 * file from the vault. This is the disaster-recovery / "Reparar" path.
 * Requires the vault unlocked. Never aborts on one failure.
 */
export function resyncOperationalCopies(deps: SyncOperationalCopyDeps, clientId?: string): ResyncResult[] {
  const all = clientId ? deps.vaultCredentialsRepo.listByClient(clientId) : deps.vaultCredentialsRepo.listAll();
  const linked = all.filter((c) => c.linkedTransportId || c.linkedDatabaseConnectionId);
  const out: ResyncResult[] = [];
  for (const cred of linked) {
    let result: SyncOperationalCopyResult;
    try {
      result = syncOperationalCopy(deps, cred.id, { useForBackups: true });
    } catch (err) {
      result = { ok: false, state: 'error', message: err instanceof Error ? err.message : String(err) };
    }
    out.push({ credentialId: cred.id, name: cred.name, result });
  }
  return out;
}
