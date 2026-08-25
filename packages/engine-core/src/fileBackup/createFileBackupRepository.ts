import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { ClientsRepo } from '../db/repositories/clientsRepo.js';
import type { SecretStore } from '../secrets/types.js';
import type { FileBackupRepositoriesRepo } from './db/repositories/fileBackupRepositoriesRepo.js';
import type { FileBackupRepository } from './types.js';
import * as resticClient from './restic/resticClient.js';

export interface CreateFileBackupRepositoryDeps {
  clientsRepo: ClientsRepo;
  fileBackupRepositoriesRepo: FileBackupRepositoriesRepo;
  secretStore: SecretStore;
}

export interface CreateFileBackupRepositoryResult {
  repository: FileBackupRepository;
  /**
   * The plaintext recovery key. Shown here, once, at creation time — the one
   * moment it's freshest in whoever's setting this up's mind to save
   * externally (a password manager, printed and filed, etc.) — but it is
   * NOT a one-time-only reveal: it's re-fetchable at any point later via
   * exportFileBackupRepositoryKey, since the secret persists in SecretStore
   * regardless and pretending otherwise would be misleading.
   */
  recoveryKey: string;
}

/**
 * Creates the one restic repository a client's file-backup tasks share.
 * Generates a random recovery key (32 random bytes, base64url — not a
 * user-typed password; nothing about it is meant to be memorized), stores it
 * via the existing SecretStore (same DPAPI LocalMachine mechanism as every
 * other secret in this app, so day-to-day scheduled backups need no
 * prompt), runs `restic init`, and records the repository row.
 *
 * Repository creation is a deliberately separate, explicit step (not a lazy
 * side effect of the first task run) specifically so the recovery key can be
 * surfaced at a moment a human is actually looking, not silently generated
 * during an unattended 3am scheduled run.
 */
export async function createFileBackupRepository(
  clientId: string,
  deps: CreateFileBackupRepositoryDeps
): Promise<CreateFileBackupRepositoryResult> {
  const client = deps.clientsRepo.getById(clientId);
  if (!client) throw new Error(`Client ${clientId} not found.`);

  const existing = deps.fileBackupRepositoriesRepo.getByClientId(clientId);
  if (existing) throw new Error(`Client ${clientId} already has a file-backup repository (${existing.id}).`);

  const repoPath = join(client.localBasePath, '_restic-repo');
  const recoveryKey = randomBytes(32).toString('base64url');
  const passwordSecretRef = `file-backup-repository:${clientId}:password`;
  deps.secretStore.set(passwordSecretRef, recoveryKey);

  const repository = deps.fileBackupRepositoriesRepo.create({ clientId, repoPath, passwordSecretRef });

  const { resticRepoId } = await resticClient.initRepository(repoPath, recoveryKey);
  deps.fileBackupRepositoriesRepo.markInitialized(repository.id, resticRepoId);

  const updated = deps.fileBackupRepositoriesRepo.getById(repository.id);
  if (!updated) throw new Error(`Failed to read back file-backup repository ${repository.id} after initialization.`);

  return { repository: updated, recoveryKey };
}

/**
 * Re-decrypts and returns the plaintext recovery key on demand — the
 * explicit "export" the user asked for, distinct from automatic storage:
 * recovery of a file-backup repository must not depend exclusively on this
 * machine's own DPAPI/secrets table, so there has to be a way to get the key
 * out at any time, not just once at creation.
 */
export function exportFileBackupRepositoryKey(
  repositoryId: string,
  deps: Pick<CreateFileBackupRepositoryDeps, 'fileBackupRepositoriesRepo' | 'secretStore'>
): string {
  const repository = deps.fileBackupRepositoriesRepo.getById(repositoryId);
  if (!repository) throw new Error(`File-backup repository ${repositoryId} not found.`);
  const key = deps.secretStore.get(repository.passwordSecretRef);
  if (!key) throw new Error(`Could not resolve the recovery key for file-backup repository ${repositoryId}.`);
  return key;
}
