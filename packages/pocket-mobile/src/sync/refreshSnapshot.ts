import type { PocketCryptoAdapter } from 'pocket-shared';
import { decideSnapshotUpdate, type SnapshotUpdateDecision } from './syncState';

/**
 * Every way a refresh can end, from the UI's point of view. Only `updated`
 * ever means "the cache changed" — every other outcome means "nothing
 * changed, here's why," which is exactly the distinction the offline/error
 * banner needs (never say "sincronizado" for anything but `updated` or a
 * previous successful check that's still fresh).
 */
export type RefreshOutcome =
  | { kind: 'updated'; revision: number }
  | { kind: 'up_to_date' }
  | { kind: 'network_error'; message: string }
  | { kind: 'oauth_error'; message: string }
  | { kind: 'corrupt'; message: string }
  | { kind: 'decrypt_failed'; message: string }
  | { kind: 'unsupported_format'; message: string };

/**
 * Every external effect this module needs, injected — so this orchestrator
 * (the actual "download → decide → what happened" flow) is testable with
 * fakes, with zero network/RN dependency, the same seam-injection pattern
 * Desktop's own runPocketPublish.ts uses for rclone.
 */
export interface RefreshSnapshotDeps {
  getAccessToken: () => Promise<string>;
  resolveFileId: (accessToken: string, hint: { fileId: string | null; fileName: string }) => Promise<string>;
  downloadFile: (accessToken: string, fileId: string) => Promise<Uint8Array>;
  cryptoAdapter: PocketCryptoAdapter;
}

export interface PairingHint {
  dek: Uint8Array;
  driveFileId: string | null;
  fileName: string;
}

export interface RefreshResult {
  outcome: RefreshOutcome;
  /** Present only when a candidate file was successfully parsed (adopt, or a decrypt/reject after a successful download). */
  decision?: SnapshotUpdateDecision;
  /** Present only on `updated` — the caller persists these bytes as the new cache. */
  bytes?: Uint8Array;
}

export async function refreshSnapshot(deps: RefreshSnapshotDeps, pairing: PairingHint, currentRevision: number | null): Promise<RefreshResult> {
  let accessToken: string;
  try {
    accessToken = await deps.getAccessToken();
  } catch (err) {
    return { outcome: { kind: 'oauth_error', message: err instanceof Error ? err.message : String(err) } };
  }

  let bytes: Uint8Array;
  try {
    const fileId = await deps.resolveFileId(accessToken, { fileId: pairing.driveFileId, fileName: pairing.fileName });
    bytes = await deps.downloadFile(accessToken, fileId);
  } catch (err) {
    return { outcome: { kind: 'network_error', message: err instanceof Error ? err.message : String(err) } };
  }

  const decision = decideSnapshotUpdate(currentRevision, bytes, pairing.dek, deps.cryptoAdapter);
  if (decision.kind === 'adopt') {
    return { outcome: { kind: 'updated', revision: decision.file.revision }, decision, bytes };
  }
  if (decision.kind === 'no_change') {
    return { outcome: { kind: 'up_to_date' }, decision };
  }
  return { outcome: { kind: decision.reason, message: decision.message }, decision };
}
