import { describe, expect, it, vi } from 'vitest';
import { looksLikeStaleLock, withStaleLockRetry } from '../../../src/fileBackup/restic/resticClient.js';

describe('looksLikeStaleLock', () => {
  it('matches restic\'s real lock-error phrasings', () => {
    expect(looksLikeStaleLock(new Error('unable to create lock in backend: repository is already locked exclusively by PID 1234 on host'))).toBe(true);
    expect(looksLikeStaleLock(new Error('repository is already locked by PID 99 ...'))).toBe(true);
    expect(looksLikeStaleLock({ message: 'x', stderr: 'Fatal: failed to create lock: ...' })).toBe(true);
  });

  it('does not match an unrelated failure', () => {
    expect(looksLikeStaleLock(new Error('wrong password'))).toBe(false);
    expect(looksLikeStaleLock(new Error('no space left on device'))).toBe(false);
  });
});

describe('withStaleLockRetry', () => {
  it('runs the op once when it succeeds', async () => {
    const op = vi.fn().mockResolvedValue('ok');
    const unlock = vi.fn();
    await expect(withStaleLockRetry('/repo', 'pw', op, unlock)).resolves.toBe('ok');
    expect(op).toHaveBeenCalledTimes(1);
    expect(unlock).not.toHaveBeenCalled();
  });

  it('on a lock error: unlocks once, then retries the op once', async () => {
    const op = vi
      .fn()
      .mockRejectedValueOnce(new Error('unable to create lock in backend: repository is already locked'))
      .mockResolvedValueOnce('ok-second-try');
    const unlock = vi.fn().mockResolvedValue(undefined);

    await expect(withStaleLockRetry('/repo', 'pw', op, unlock)).resolves.toBe('ok-second-try');
    expect(unlock).toHaveBeenCalledTimes(1);
    expect(unlock).toHaveBeenCalledWith('/repo', 'pw');
    expect(op).toHaveBeenCalledTimes(2);
  });

  it('does not retry a non-lock error', async () => {
    const op = vi.fn().mockRejectedValue(new Error('permission denied'));
    const unlock = vi.fn();
    await expect(withStaleLockRetry('/repo', 'pw', op, unlock)).rejects.toThrow('permission denied');
    expect(unlock).not.toHaveBeenCalled();
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('only retries once — a still-locked second attempt propagates', async () => {
    const op = vi.fn().mockRejectedValue(new Error('repository is already locked'));
    const unlock = vi.fn().mockResolvedValue(undefined);
    await expect(withStaleLockRetry('/repo', 'pw', op, unlock)).rejects.toThrow('already locked');
    expect(op).toHaveBeenCalledTimes(2);
    expect(unlock).toHaveBeenCalledTimes(1);
  });
});
