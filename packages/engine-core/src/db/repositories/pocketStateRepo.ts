import type { Database } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

/**
 * Desktop-side Pocket state — see `pocket_state`'s own migration comment for
 * the full rationale behind `changeSeq`/`publishedSeq` and why `dirty` is a
 * SQL-trigger-driven derived value, not an application-set flag.
 */
export interface PocketState {
  pocketId: string;
  configured: boolean;
  enabled: boolean;
  driveRemotePath: string | null;
  driveFileId: string | null;
  /** True iff some Pocket-relevant change happened after the last CONFIRMED publish. */
  dirty: boolean;
  dirtySince: string | null;
  lastAttemptedRevision: number | null;
  lastConfirmedRevision: number | null;
  lastAttemptAt: string | null;
  lastSuccessfulPublishAt: string | null;
  lastError: string | null;
  deviceLabel: string | null;
  pairedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface PocketStateRow {
  id: number;
  pocket_id: string;
  configured: number;
  enabled: number;
  drive_remote_path: string | null;
  drive_file_id: string | null;
  change_seq: number;
  published_seq: number;
  dirty_since: string | null;
  last_attempted_revision: number | null;
  last_confirmed_revision: number | null;
  last_attempt_at: string | null;
  last_successful_publish_at: string | null;
  last_error: string | null;
  device_label: string | null;
  paired_at: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

function toDomain(r: PocketStateRow): PocketState {
  return {
    pocketId: r.pocket_id,
    configured: r.configured === 1,
    enabled: r.enabled === 1,
    driveRemotePath: r.drive_remote_path,
    driveFileId: r.drive_file_id,
    dirty: r.change_seq > r.published_seq,
    dirtySince: r.dirty_since,
    lastAttemptedRevision: r.last_attempted_revision,
    lastConfirmedRevision: r.last_confirmed_revision,
    lastAttemptAt: r.last_attempt_at,
    lastSuccessfulPublishAt: r.last_successful_publish_at,
    lastError: r.last_error,
    deviceLabel: r.device_label,
    pairedAt: r.paired_at,
    revokedAt: r.revoked_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** What `beginPublishAttempt` hands the caller — captured BEFORE the snapshot is built. */
export interface PocketPublishAttempt {
  /** The change_seq value at the moment this attempt started — pass back to confirmPublish unchanged. */
  targetSeq: number;
  /** lastConfirmedRevision + 1 — the revision number this attempt's snapshot should be tagged with. */
  targetRevision: number;
}

export interface PocketStateRepo {
  get(): PocketState | null;
  /** First-time setup, or changing the Drive folder later — idempotent either way. */
  configure(input: { driveRemotePath: string }): PocketState;
  setEnabled(enabled: boolean): PocketState;
  setDriveFileId(fileId: string | null): void;
  /** Records "we are about to try publishing" and allocates the attempt's revision/seq. Throws if not configured. */
  beginPublishAttempt(): PocketPublishAttempt;
  /**
   * Records a CONFIRMED successful publish. `targetSeq`/`revision` must be
   * exactly what `beginPublishAttempt` returned for this same attempt — if
   * a Pocket-relevant mutation landed while the upload was in flight,
   * change_seq will already have moved past `targetSeq`, so `dirty` stays
   * true afterwards, correctly queuing a follow-up publish.
   */
  confirmPublish(targetSeq: number, revision: number): PocketState;
  recordFailure(error: string): void;
  recordPairing(deviceLabel: string | null): PocketState;
  /** Forces `dirty` (even with no content change) so the next publish uses the freshly rotated DEK. */
  recordRevocation(): PocketState;
  reset(): void;
}

const POCKET_ROW_ID = 1;

export function createPocketStateRepo(db: Database): PocketStateRepo {
  const getStmt = db.prepare<[number], PocketStateRow>('SELECT * FROM pocket_state WHERE id = ?');
  // published_seq starts at -1 (not 0) so a freshly-configured Pocket reads
  // as dirty ("Pendiente de publicar") immediately — change_seq starts at 0
  // too, and any credential/URL created BEFORE Pocket was ever configured
  // never had a chance to bump change_seq (the trigger no-ops with no row
  // to update), so without this a first-time configure with pre-existing
  // vault data would incorrectly read as "up to date" with nothing to sync.
  const insertStmt = db.prepare(
    `INSERT INTO pocket_state (id, pocket_id, configured, drive_remote_path, published_seq)
     VALUES (@id, @pocketId, 1, @driveRemotePath, -1)`
  );

  function requireRow(): PocketStateRow {
    const row = getStmt.get(POCKET_ROW_ID);
    if (!row) throw new Error('Arkode Pocket has not been configured yet.');
    return row;
  }

  return {
    get() {
      const row = getStmt.get(POCKET_ROW_ID);
      return row ? toDomain(row) : null;
    },

    configure(input) {
      const existing = getStmt.get(POCKET_ROW_ID);
      if (!existing) {
        insertStmt.run({ id: POCKET_ROW_ID, pocketId: randomUUID(), driveRemotePath: input.driveRemotePath });
      } else {
        db.prepare(
          `UPDATE pocket_state
             SET drive_remote_path = @driveRemotePath, configured = 1,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
           WHERE id = @id`
        ).run({ id: POCKET_ROW_ID, driveRemotePath: input.driveRemotePath });
      }
      return toDomain(requireRow());
    },

    setEnabled(enabled) {
      requireRow();
      db.prepare(
        `UPDATE pocket_state SET enabled = @enabled, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = @id`
      ).run({ id: POCKET_ROW_ID, enabled: enabled ? 1 : 0 });
      return toDomain(requireRow());
    },

    setDriveFileId(fileId) {
      requireRow();
      db.prepare(
        `UPDATE pocket_state SET drive_file_id = @fileId, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = @id`
      ).run({ id: POCKET_ROW_ID, fileId });
    },

    beginPublishAttempt() {
      const row = requireRow();
      const targetSeq = row.change_seq;
      const targetRevision = (row.last_confirmed_revision ?? 0) + 1;
      db.prepare(
        `UPDATE pocket_state
           SET last_attempted_revision = @targetRevision,
               last_attempt_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = @id`
      ).run({ id: POCKET_ROW_ID, targetRevision });
      return { targetSeq, targetRevision };
    },

    confirmPublish(targetSeq, revision) {
      requireRow();
      db.prepare(
        `UPDATE pocket_state
           SET published_seq = @targetSeq,
               last_confirmed_revision = @revision,
               last_successful_publish_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
               last_error = NULL,
               dirty_since = CASE WHEN change_seq <= @targetSeq THEN NULL ELSE dirty_since END,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = @id`
      ).run({ id: POCKET_ROW_ID, targetSeq, revision });
      return toDomain(requireRow());
    },

    recordFailure(error) {
      requireRow();
      db.prepare(
        `UPDATE pocket_state SET last_error = @error, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = @id`
      ).run({ id: POCKET_ROW_ID, error });
    },

    recordPairing(deviceLabel) {
      requireRow();
      db.prepare(
        `UPDATE pocket_state
           SET paired_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), device_label = @deviceLabel,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = @id`
      ).run({ id: POCKET_ROW_ID, deviceLabel });
      return toDomain(requireRow());
    },

    recordRevocation() {
      requireRow();
      // Bump change_seq even though no credential/URL content changed — the
      // KEY changed, so the next publish must run regardless of `dirty`'s
      // usual content-based meaning.
      db.prepare(
        `UPDATE pocket_state
           SET change_seq = change_seq + 1,
               revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
               dirty_since = COALESCE(dirty_since, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = @id`
      ).run({ id: POCKET_ROW_ID });
      return toDomain(requireRow());
    },

    reset() {
      db.prepare('DELETE FROM pocket_state WHERE id = ?').run(POCKET_ROW_ID);
    },
  };
}
