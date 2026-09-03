import type { RunProgress, RunProgressPhase } from '../types.js';

/**
 * How the orchestrators hand live progress back to their caller. The runId
 * is passed here (not captured) because a batch caller like `runDueTasks`
 * forwards one sink down to many `runBackupTask` calls — the sink dispatches
 * to the right run row by id. Best-effort: a sink must never throw.
 */
export type ProgressSink = (runId: string, progress: RunProgress) => void;

/** What an executor / phase reports — `updatedAt` is stamped by the reporter; `label` defaults per phase. */
export interface ProgressUpdate {
  phase: RunProgressPhase;
  /** 0..1 when known; null for indeterminate phases. */
  fraction: number | null;
  current?: number;
  total?: number;
  unit?: 'bytes' | 'files';
  etaSeconds?: number;
  /** Overrides the default Spanish phase label. */
  label?: string;
}

export type ReportProgress = (update: ProgressUpdate) => void;

const PHASE_LABEL: Record<RunProgressPhase, string> = {
  connecting: 'Conectando…',
  remote_dump: 'Generando dump en el servidor…',
  downloading: 'Descargando…',
  dumping: 'Generando dump…',
  syncing: 'Sincronizando archivos…',
  archiving: 'Copiando al repositorio…',
  validating: 'Validando…',
  finalizing: 'Finalizando…',
};

/** Binds a run id + sink into a `report(update)` the orchestrator and its executor call. A no-op when no sink was provided. */
export function makeProgressReporter(runId: string, sink: ProgressSink | undefined): ReportProgress {
  if (!sink) return () => {};
  return (update) => {
    const progress: RunProgress = {
      phase: update.phase,
      label: update.label ?? PHASE_LABEL[update.phase],
      fraction: update.fraction,
      current: update.current,
      total: update.total,
      unit: update.unit,
      etaSeconds: update.etaSeconds,
      updatedAt: new Date().toISOString(),
    };
    try {
      sink(runId, progress);
    } catch {
      // progress is best-effort — never let a write failure break a run
    }
  };
}

/**
 * Wraps a ProgressSink so writes are throttled: at most one every
 * `minIntervalMs`, unless the phase changed or the fraction advanced by at
 * least `minFractionStep` (or reached 1). Keeps per-run state, so it's safe
 * to share one wrapped sink across many concurrent runs. This is where the
 * "don't hammer SQLite every chunk" policy lives — the engine-cli wiring
 * uses it; tests that want every update can skip it.
 */
export function throttleProgressSink(
  sink: ProgressSink,
  opts: { minIntervalMs?: number; minFractionStep?: number } = {}
): ProgressSink {
  const minIntervalMs = opts.minIntervalMs ?? 800;
  const minFractionStep = opts.minFractionStep ?? 0.01;
  const state = new Map<string, { at: number; fraction: number | null; phase: string }>();
  return (runId, progress) => {
    const prev = state.get(runId);
    const now = Date.now();
    const fractionJumped =
      progress.fraction != null &&
      (prev?.fraction == null || progress.fraction - prev.fraction >= minFractionStep || progress.fraction >= 1);
    const shouldWrite = prev == null || progress.phase !== prev.phase || now - prev.at >= minIntervalMs || fractionJumped;
    if (!shouldWrite) return;
    state.set(runId, { at: now, fraction: progress.fraction, phase: progress.phase });
    sink(runId, progress);
  };
}
