import type { ScheduleFrequency } from 'engine-core';

const WEEKDAY_ABBR: Record<number, string> = { 0: 'Dom', 1: 'Lun', 2: 'Mar', 3: 'Mié', 4: 'Jue', 5: 'Vie', 6: 'Sáb' };

export interface ScheduleLike {
  scheduleTime: string | null;
  scheduleEnabled: boolean;
  scheduleFrequency: ScheduleFrequency;
  scheduleDaysOfWeek: number[] | null;
  scheduleDayOfMonth: number | null;
}

/** "03:00 · Diario", "03:00 · Lun, Mié, Vie", "03:00 · Día 15", each with " (deshabilitado)" appended when disabled — "Sin programar" if there's no time at all. */
export function formatSchedule(task: ScheduleLike): string {
  if (!task.scheduleTime) return 'Sin programar';
  let frequencyPart: string;
  if (task.scheduleFrequency === 'weekly' && task.scheduleDaysOfWeek?.length) {
    frequencyPart = task.scheduleDaysOfWeek.map((d) => WEEKDAY_ABBR[d]).join(', ');
  } else if (task.scheduleFrequency === 'monthly' && task.scheduleDayOfMonth != null) {
    frequencyPart = `Día ${task.scheduleDayOfMonth}`;
  } else {
    frequencyPart = 'Diario';
  }
  return `${task.scheduleTime} · ${frequencyPart}${task.scheduleEnabled ? '' : ' (deshabilitado)'}`;
}

/** "512 B", "84 KB", "142 MB", "1.2 GB" — scales the unit so a sub-MB backup doesn't read as "0 MB". */
export function formatSize(bytes: number | null): string {
  if (bytes == null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

/** "11 h", "35 h" for recent backups (matches project.md's example); "N d" once it's been more than 2 days — a month-old backup as "720 h" would be unreadable. */
export function formatAge(isoTimestamp: string | null, now: Date = new Date()): string {
  if (isoTimestamp == null) return '—';
  const ms = now.getTime() - new Date(isoTimestamp).getTime();
  const hours = Math.max(0, Math.round(ms / (1000 * 60 * 60)));
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} d`;
}

export function ageInHours(isoTimestamp: string | null, now: Date = new Date()): number | null {
  if (isoTimestamp == null) return null;
  return (now.getTime() - new Date(isoTimestamp).getTime()) / (1000 * 60 * 60);
}

/** "10 backups / 30 días", "10 backups", "—" if neither policy is set. */
export function formatRetention(count: number | null, days: number | null): string {
  const parts: string[] = [];
  if (count != null) parts.push(`${count} backups`);
  if (days != null) parts.push(`${days} días`);
  return parts.length > 0 ? parts.join(' / ') : '—';
}

/** "45 s", "3 min", "1 h 12 min" — a still-running attempt (no duration yet) shows as "—". */
export function formatDuration(durationMs: number | null): string {
  if (durationMs == null) return '—';
  const totalSeconds = Math.round(durationMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds} s`;
  const totalMinutes = Math.round(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours} h ${minutes} min` : `${hours} h`;
}

/** " · Servidor: 18.0 · Cliente: psql (PostgreSQL) 18.0" — appended after a connection test's message/latency, when either version was detected (direct_dump only; never populated for SFTP/SSH transport tests). Empty string otherwise. */
export function formatConnectionTestVersions(result: { serverVersion?: string; localToolVersion?: string }): string {
  const parts: string[] = [];
  if (result.serverVersion) parts.push(`Servidor: ${result.serverVersion}`);
  if (result.localToolVersion) parts.push(`Cliente: ${result.localToolVersion}`);
  return parts.length > 0 ? ` · ${parts.join(' · ')}` : '';
}

/** "24/8, 09:15" — a compact absolute timestamp for a history table (age alone isn't enough once you're looking at many rows). */
export function formatDateTime(isoTimestamp: string | null): string {
  if (isoTimestamp == null) return '—';
  return new Date(isoTimestamp).toLocaleString('es-AR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}
