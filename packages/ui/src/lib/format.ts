/** "142 MB", "1.2 GB" — matches project.md's own dashboard example formatting. */
export function formatSize(bytes: number | null): string {
  if (bytes == null) return '—';
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${Math.round(mb)} MB`;
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
