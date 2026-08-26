/** A small muted label next to a task/run's name when it belongs to a backup set — same visual weight as the existing "(inactiva)" suffix pattern. Renders nothing when unassigned. */
export function BackupSetBadge({ name }: { name: string | null | undefined }) {
  if (!name) return null;
  return (
    <span
      className="ml-2 rounded-full px-2 py-0.5 text-xs font-normal"
      style={{ color: 'var(--muted)', backgroundColor: 'var(--surface-secondary)' }}
    >
      {name}
    </span>
  );
}
