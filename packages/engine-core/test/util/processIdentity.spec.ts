import { describe, expect, it } from 'vitest';
import { isStaleInProgressRun, IN_PROGRESS_SCRUTINY_AFTER_MS, MAX_IN_PROGRESS_RUN_MS } from '../../src/util/processIdentity.js';

const NOW = Date.parse('2026-08-29T12:00:00.000Z');
function ago(ms: number): string {
  return new Date(NOW - ms).toISOString();
}

describe('isStaleInProgressRun', () => {
  it('is stale when no pid was recorded', () => {
    expect(isStaleInProgressRun({ pid: null, startedAt: ago(60_000) }, { now: NOW })).toBe(true);
  });

  it('is stale when the pid is no longer in use', () => {
    expect(
      isStaleInProgressRun({ pid: 4242, startedAt: ago(60_000) }, { now: NOW, isPidInUse: () => false })
    ).toBe(true);
  });

  it('is NOT stale — and does no start-time query — for a recent run whose pid is alive', () => {
    let queried = false;
    const stale = isStaleInProgressRun(
      { pid: 4242, startedAt: ago(5 * 60_000) },
      {
        now: NOW,
        isPidInUse: () => true,
        processStartTimeMs: () => {
          queried = true;
          return NOW;
        },
      }
    );
    expect(stale).toBe(false);
    expect(queried).toBe(false); // under the scrutiny threshold -> trusted, no OS call
  });

  it('is stale when an old run\'s pid is alive but its holder started AFTER the run row (recycled pid)', () => {
    const startedAt = ago(IN_PROGRESS_SCRUTINY_AFTER_MS + 60_000);
    const stale = isStaleInProgressRun(
      { pid: 4242, startedAt },
      {
        now: NOW,
        isPidInUse: () => true,
        // holder started 1 minute ago — well after the run row was written
        processStartTimeMs: () => NOW - 60_000,
      }
    );
    expect(stale).toBe(true);
  });

  it('is NOT stale when an old run\'s pid holder started BEFORE the run row (still genuinely ours)', () => {
    const startedAt = ago(IN_PROGRESS_SCRUTINY_AFTER_MS + 60_000);
    const stale = isStaleInProgressRun(
      { pid: 4242, startedAt },
      {
        now: NOW,
        isPidInUse: () => true,
        processStartTimeMs: () => Date.parse(startedAt) - 5_000, // started just before the row
      }
    );
    expect(stale).toBe(false);
  });

  it('is stale past the 24h ceiling even when the holder start time is unknowable', () => {
    const stale = isStaleInProgressRun(
      { pid: 4242, startedAt: ago(MAX_IN_PROGRESS_RUN_MS + 60_000) },
      { now: NOW, isPidInUse: () => true, processStartTimeMs: () => null }
    );
    expect(stale).toBe(true);
  });

  it('is NOT stale below the 24h ceiling when the holder start time is unknowable', () => {
    const stale = isStaleInProgressRun(
      { pid: 4242, startedAt: ago(2 * 60 * 60_000) },
      { now: NOW, isPidInUse: () => true, processStartTimeMs: () => null }
    );
    expect(stale).toBe(false);
  });
});
