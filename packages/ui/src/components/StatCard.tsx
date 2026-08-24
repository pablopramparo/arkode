import type { ReactNode } from 'react';

const COLOR_STYLES: Record<string, { bg: string; fg: string }> = {
  blue: { bg: 'color-mix(in oklab, #3b82f6 20%, transparent)', fg: '#60a5fa' },
  purple: { bg: 'color-mix(in oklab, #8b5cf6 20%, transparent)', fg: '#a78bfa' },
  green: { bg: 'color-mix(in oklab, #10b981 20%, transparent)', fg: '#34d399' },
  red: { bg: 'color-mix(in oklab, #ef4444 20%, transparent)', fg: '#f87171' },
};

export function StatCard({
  icon,
  value,
  label,
  sublabel,
  color,
}: {
  icon: ReactNode;
  value: number;
  label: string;
  sublabel?: string;
  color: 'blue' | 'purple' | 'green' | 'red';
}) {
  const c = COLOR_STYLES[color];
  return (
    <div className="flex items-center gap-3 rounded-xl border p-4" style={{ borderColor: 'var(--border)' }}>
      <div
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg"
        style={{ backgroundColor: c.bg, color: c.fg }}
      >
        <span className="h-5 w-5 [&>svg]:h-5 [&>svg]:w-5">{icon}</span>
      </div>
      <div>
        <div className="text-xl font-semibold leading-tight">{value}</div>
        <div className="text-sm" style={{ color: 'var(--foreground)' }}>
          {label}
        </div>
        {sublabel && (
          <div className="text-xs" style={{ color: 'var(--muted)' }}>
            {sublabel}
          </div>
        )}
      </div>
    </div>
  );
}
