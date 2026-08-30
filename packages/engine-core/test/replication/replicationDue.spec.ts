import { describe, expect, it } from 'vitest';
import { isReplicationDue, type ReplicationDueDeps } from '../../src/replication/replicationDue.js';
import type { ReplicationTarget } from '../../src/replication/types.js';

const NOW = new Date('2026-08-30T12:00:00Z');

function target(over: Partial<ReplicationTarget> = {}): ReplicationTarget {
  return {
    id: 't1',
    clientId: 'c1',
    content: 'restic_repo',
    provider: 'rclone_drive',
    remotePath: 'p',
    rcloneConfigSecretRef: 'r',
    encryptWithCrypt: false,
    cryptPasswordSecretRef: null,
    enabled: true,
    lastReplicatedAt: null,
    lastStatus: null,
    lastError: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...over,
  };
}

/** deps where the client's latest successful backup finished at `backupAt` (or none). */
function deps(backupAt: string | null): ReplicationDueDeps {
  const rows = backupAt ? [{ status: 'Success', finishedAt: backupAt }] : [];
  const listRecent = () => rows as never;
  return { runsRepo: { listRecent }, fileBackupRunsRepo: { listRecent } };
}

describe('isReplicationDue', () => {
  it('a disabled target is never due', () => {
    expect(isReplicationDue(target({ enabled: false }), deps(null), { now: NOW })).toBe(false);
  });

  it('a never-replicated target is due', () => {
    expect(isReplicationDue(target(), deps(null), { now: NOW })).toBe(true);
  });

  it('after a Failed last run, due once the interval floor has passed (retry) — not before', () => {
    const t = target({ lastReplicatedAt: '2026-08-30T11:58:00Z', lastStatus: 'Failed' });
    expect(isReplicationDue(t, deps(null), { now: NOW })).toBe(false); // only 2 min since
    expect(isReplicationDue(t, deps(null), { now: new Date('2026-08-30T12:10:00Z') })).toBe(true);
  });

  it('after a Success, due only when a newer backup exists for the client', () => {
    const t = target({ lastReplicatedAt: '2026-08-30T10:00:00Z', lastStatus: 'Success' });
    // newest backup is older than the last replication -> nothing new
    expect(isReplicationDue(t, deps('2026-08-30T09:00:00Z'), { now: NOW })).toBe(false);
    // newest backup is newer -> due
    expect(isReplicationDue(t, deps('2026-08-30T11:00:00Z'), { now: NOW })).toBe(true);
    // no backups at all -> not due
    expect(isReplicationDue(t, deps(null), { now: NOW })).toBe(false);
  });

  it('respects the interval floor even when a newer backup exists', () => {
    const t = target({ lastReplicatedAt: '2026-08-30T11:59:00Z', lastStatus: 'Success' });
    expect(isReplicationDue(t, deps('2026-08-30T11:59:30Z'), { now: NOW })).toBe(false); // 1 min since last
  });

  it('db_dumps content reads DB runs, restic_repo reads file-backup runs', () => {
    const dbOnly: ReplicationDueDeps = {
      runsRepo: { listRecent: () => [{ status: 'Success', finishedAt: '2026-08-30T11:00:00Z' }] as never },
      fileBackupRunsRepo: { listRecent: () => [] as never },
    };
    const base = { lastReplicatedAt: '2026-08-30T10:00:00Z', lastStatus: 'Success' as const };
    expect(isReplicationDue(target({ ...base, content: 'db_dumps' }), dbOnly, { now: NOW })).toBe(true);
    expect(isReplicationDue(target({ ...base, content: 'restic_repo' }), dbOnly, { now: NOW })).toBe(false);
  });
});
