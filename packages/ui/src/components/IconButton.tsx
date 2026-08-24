import type { ReactNode } from 'react';

/** A quiet icon-only action with a native tooltip (title) — for secondary row actions that shouldn't compete visually with the primary action. */
export function IconButton({
  icon,
  label,
  onPress,
  disabled,
  tone = 'muted',
}: {
  icon: ReactNode;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  tone?: 'muted' | 'danger';
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onPress}
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-colors disabled:opacity-40"
      style={{ color: tone === 'danger' ? 'var(--danger)' : 'var(--muted)' }}
      onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--surface-secondary)')}
      onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
    >
      <span className="h-4 w-4 [&>svg]:h-4 [&>svg]:w-4">{icon}</span>
    </button>
  );
}
