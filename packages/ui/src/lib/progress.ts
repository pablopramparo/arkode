import type { RunProgress } from 'engine-core';
import { formatSize } from './format';

const IN_PROGRESS_STATUSES = new Set(['Pending', 'Running', 'Producing', 'Validating']);
/** A run that's genuinely alive writes progress ~1/s; anything older than this on an "in progress" row is a leftover from a crash. */
const STALE_MS = 30_000;

/** True when a run's progress blob is worth rendering: the run is still in progress and the blob is recent. */
export function isLiveProgress(status: string, progress: RunProgress | null | undefined): progress is RunProgress {
  if (!progress || !IN_PROGRESS_STATUSES.has(status)) return false;
  const age = Date.now() - Date.parse(progress.updatedAt);
  return Number.isFinite(age) && age >= 0 && age < STALE_MS;
}

/** "1.2 / 4.8 GB", "45 / 312 archivos", or "" when there's nothing countable. */
export function formatProgressCount(p: RunProgress): string {
  if (p.current == null) return '';
  if (p.unit === 'bytes') {
    return p.total != null && p.total > 0 ? `${formatSize(p.current)} / ${formatSize(p.total)}` : formatSize(p.current);
  }
  if (p.unit === 'files') {
    return p.total != null ? `${p.current} / ${p.total} archivos` : `${p.current} archivos`;
  }
  return '';
}

/** "~45 s", "~3 min", "~1 h 20 min", or "" when no usable ETA. */
export function formatEta(seconds: number | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 60) return `~${Math.round(seconds)} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `~${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `~${hours} h ${minutes % 60} min`;
}
