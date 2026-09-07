import { generatePocketDek, hasPocketDek } from './pocketDek.js';
import type { SecretStore } from '../../secrets/types.js';
import type { PocketState, PocketStateRepo } from '../../db/repositories/pocketStateRepo.js';

export interface PocketSetupDeps {
  pocketStateRepo: PocketStateRepo;
  secretStore: SecretStore;
}

/**
 * First-time setup (or changing the configured Drive folder later — safe to
 * call again). Generates the Pocket DEK on first configuration only; a
 * re-configure (e.g. just editing the Drive path) never rotates it — that's
 * what "Revocar dispositivo" is for.
 */
export function configurePocket(deps: PocketSetupDeps, input: { driveRemotePath: string }): PocketState {
  deps.pocketStateRepo.configure(input);
  if (!hasPocketDek(deps.secretStore)) {
    generatePocketDek(deps.secretStore);
  }
  return deps.pocketStateRepo.get()!;
}

export function setPocketEnabled(deps: PocketSetupDeps, enabled: boolean): PocketState {
  return deps.pocketStateRepo.setEnabled(enabled);
}
