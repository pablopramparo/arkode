/**
 * Distinguishes the two backup domains wherever a unified list mixes them
 * (Dashboard, Tareas, Historial): DB-dump tasks vs. restic-backed file
 * tasks. Same visual weight as BackupSetBadge — a small inline pill, not a
 * loud tag.
 */
export function KindBadge({ kind }: { kind: 'db' | 'file' }) {
  const label = kind === 'file' ? 'Archivos' : 'Base de datos';
  const color = kind === 'file' ? 'var(--accent)' : 'var(--muted)';
  return (
    <span
      className="ml-2 rounded-full px-2 py-0.5 text-xs font-normal"
      style={{ color, backgroundColor: `color-mix(in oklab, ${color} 14%, transparent)` }}
    >
      {label}
    </span>
  );
}
