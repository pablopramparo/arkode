import { readCredentialSecret } from '../credentialBlob.js';
import type { VaultSecretStore } from '../vaultSecretStore.js';
import type { ClientsRepo } from '../../db/repositories/clientsRepo.js';
import type { VaultCredentialsRepo } from '../../db/repositories/vaultCredentialsRepo.js';
import type { VaultUrlsRepo } from '../../db/repositories/vaultUrlsRepo.js';
import type { PocketSnapshotPayload } from 'pocket-shared';

export interface BuildPocketSnapshotDeps {
  clientsRepo: ClientsRepo;
  vaultCredentialsRepo: VaultCredentialsRepo;
  vaultUrlsRepo: VaultUrlsRepo;
  vaultSecretStore: VaultSecretStore;
}

/**
 * Builds the (still-plaintext, in-memory-only) Pocket snapshot payload.
 * Requires the vault to be UNLOCKED (reading a credential's secret throws
 * `VaultLockedError` otherwise — deliberately not caught here, so a caller
 * publishing while locked fails loudly rather than silently skipping
 * secrets). Only ACTIVE clients and their credentials/URLs are included —
 * a deactivated client (and anything under it) simply never appears in
 * Pocket, matching how every other "active-only" view in this app behaves.
 *
 * This function is the ONE place that decides what is in scope for
 * Pocket — everything it does NOT read (backup tasks, runs, repositories,
 * replication targets, transports, connections, vault items/notes,
 * settings) is exactly what pocket-shared's `validatePocketSnapshotPayload`
 * would reject if it ever leaked in by mistake.
 */
export function buildPocketSnapshotPayload(deps: BuildPocketSnapshotDeps): PocketSnapshotPayload {
  const activeClients = deps.clientsRepo.listActive();
  const activeIds = new Set(activeClients.map((c) => c.id));

  const clients = activeClients.map((c) => ({ id: c.id, name: c.name }));

  const credentials = deps.vaultCredentialsRepo
    .listAll()
    .filter((c) => activeIds.has(c.clientId))
    .map((c) => ({
      id: c.id,
      clientId: c.clientId,
      name: c.name,
      kind: c.kind,
      environment: c.environment,
      tags: c.tags,
      host: c.host,
      port: c.port,
      username: c.username,
      databaseName: c.databaseName,
      url: c.url,
      favorite: c.favorite,
      description: c.description,
      secret: c.secretBlobRef ? readCredentialSecret(deps.vaultSecretStore, c.secretBlobRef) : {},
    }));

  const urls = deps.vaultUrlsRepo
    .listAll()
    .filter((u) => activeIds.has(u.clientId))
    .map((u) => ({
      id: u.id,
      clientId: u.clientId,
      name: u.name,
      url: u.url,
      environment: u.environment,
      tags: u.tags,
      favorite: u.favorite,
      description: u.description,
    }));

  return { formatVersion: 1, clients, credentials, urls };
}
