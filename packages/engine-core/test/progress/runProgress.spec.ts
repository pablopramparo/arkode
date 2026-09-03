import { describe, expect, it, vi } from 'vitest';
import { makeProgressReporter, throttleProgressSink } from '../../src/progress/runProgress.js';
import type { RunProgress } from '../../src/types.js';

describe('makeProgressReporter', () => {
  it('is a no-op when no sink is provided', () => {
    const report = makeProgressReporter('run-1', undefined);
    expect(() => report({ phase: 'downloading', fraction: 0.5 })).not.toThrow();
  });

  it('stamps updatedAt and a default Spanish label per phase, forwarding runId', () => {
    const sink = vi.fn();
    const report = makeProgressReporter('run-42', sink);

    report({ phase: 'archiving', fraction: 0.25, current: 10, total: 40, unit: 'bytes' });

    expect(sink).toHaveBeenCalledTimes(1);
    const [runId, progress] = sink.mock.calls[0] as [string, RunProgress];
    expect(runId).toBe('run-42');
    expect(progress.label).toBe('Copiando al repositorio…');
    expect(progress.fraction).toBe(0.25);
    expect(typeof progress.updatedAt).toBe('string');
    expect(Number.isNaN(Date.parse(progress.updatedAt))).toBe(false);
  });

  it('lets an explicit label override the phase default, and swallows a throwing sink', () => {
    const sink = vi.fn(() => {
      throw new Error('db is busy');
    });
    const report = makeProgressReporter('r', sink);
    report({ phase: 'syncing', fraction: null, label: 'Sincronizando… (3/9)' });
    expect(sink.mock.calls[0][1].label).toBe('Sincronizando… (3/9)');
  });
});

describe('throttleProgressSink', () => {
  const mk = (over: Partial<RunProgress>): RunProgress => ({
    phase: 'downloading',
    label: 'Descargando…',
    fraction: 0,
    updatedAt: new Date().toISOString(),
    ...over,
  });

  it('passes the first update straight through', () => {
    const inner = vi.fn();
    throttleProgressSink(inner, { minIntervalMs: 1000 })('run', mk({ fraction: 0 }));
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('drops a rapid second update with a tiny fraction change', () => {
    const inner = vi.fn();
    const sink = throttleProgressSink(inner, { minIntervalMs: 10_000, minFractionStep: 0.05 });
    sink('run', mk({ fraction: 0 }));
    sink('run', mk({ fraction: 0.001 }));
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('lets a big fraction jump through immediately even within the interval', () => {
    const inner = vi.fn();
    const sink = throttleProgressSink(inner, { minIntervalMs: 10_000, minFractionStep: 0.05 });
    sink('run', mk({ fraction: 0 }));
    sink('run', mk({ fraction: 0.3 }));
    expect(inner).toHaveBeenCalledTimes(2);
  });

  it('always lets a phase change through', () => {
    const inner = vi.fn();
    const sink = throttleProgressSink(inner, { minIntervalMs: 10_000 });
    sink('run', mk({ phase: 'downloading', fraction: 0.9 }));
    sink('run', mk({ phase: 'validating', fraction: null }));
    expect(inner).toHaveBeenCalledTimes(2);
  });

  it('keeps per-run state — two runs do not throttle each other', () => {
    const inner = vi.fn();
    const sink = throttleProgressSink(inner, { minIntervalMs: 10_000 });
    sink('run-a', mk({ fraction: 0.1 }));
    sink('run-b', mk({ fraction: 0.1 }));
    expect(inner).toHaveBeenCalledTimes(2);
  });

  it('lets fraction === 1 through even after a small step', () => {
    const inner = vi.fn();
    const sink = throttleProgressSink(inner, { minIntervalMs: 10_000, minFractionStep: 0.5 });
    sink('run', mk({ fraction: 0.99 }));
    sink('run', mk({ fraction: 1 }));
    expect(inner).toHaveBeenCalledTimes(2);
  });
});
