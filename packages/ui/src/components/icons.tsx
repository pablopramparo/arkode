// Small original stroke icons (24x24, currentColor) — no icon library dependency added for this.
type IconProps = { className?: string };

const base = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  viewBox: '0 0 24 24',
};

export function GridIcon({ className }: IconProps) {
  return (
    <svg className={className} {...base}>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
    </svg>
  );
}

export function UsersIcon({ className }: IconProps) {
  return (
    <svg className={className} {...base}>
      <circle cx="9" cy="8" r="3" />
      <path d="M3.5 20a5.5 5.5 0 0 1 11 0" />
      <path d="M16 4.5a3 3 0 0 1 0 6.9" />
      <path d="M15.5 14.2c2.7.4 4.9 2.5 5 5.8" />
    </svg>
  );
}

export function ClipboardIcon({ className }: IconProps) {
  return (
    <svg className={className} {...base}>
      <rect x="6" y="4" width="12" height="17" rx="2" />
      <path d="M9 4V3.5A1.5 1.5 0 0 1 10.5 2h3A1.5 1.5 0 0 1 15 3.5V4" />
      <path d="M9 11h6M9 15h6M9 19h4" />
    </svg>
  );
}

export function CheckCircleIcon({ className }: IconProps) {
  return (
    <svg className={className} {...base}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M8.5 12.3l2.3 2.3 4.7-5" />
    </svg>
  );
}

export function AlertTriangleIcon({ className }: IconProps) {
  return (
    <svg className={className} {...base}>
      <path d="M12 4.5 21 19H3z" />
      <path d="M12 10v4" />
      <circle cx="12" cy="16.8" r="0.3" fill="currentColor" />
    </svg>
  );
}

export function DatabaseIcon({ className }: IconProps) {
  return (
    <svg className={className} {...base}>
      <ellipse cx="12" cy="5.5" rx="7.5" ry="2.8" />
      <path d="M4.5 5.5v13c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8v-13" />
      <path d="M4.5 12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8" />
    </svg>
  );
}

export function ClockIcon({ className }: IconProps) {
  return (
    <svg className={className} {...base}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  );
}

export function DocumentIcon({ className }: IconProps) {
  return (
    <svg className={className} {...base}>
      <path d="M7 3.5h7l4 4V19a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 19V5A1.5 1.5 0 0 1 7 3.5z" />
      <path d="M14 3.5V8h4" />
      <path d="M9 12.5h6M9 16h6" />
    </svg>
  );
}

export function DownloadIcon({ className }: IconProps) {
  return (
    <svg className={className} {...base}>
      <path d="M12 3.5v11" />
      <path d="M7.5 10.5 12 15l4.5-4.5" />
      <path d="M4.5 18.5h15" />
    </svg>
  );
}

export function ChartIcon({ className }: IconProps) {
  return (
    <svg className={className} {...base}>
      <path d="M4 20V10M11 20V4M18 20v-7" />
      <path d="M3 20h18" />
    </svg>
  );
}

export function PulseIcon({ className }: IconProps) {
  return (
    <svg className={className} {...base}>
      <path d="M3 12h3.5l2-6.5 4 13 2-9.5 1.5 3h5" />
    </svg>
  );
}

export function EyeIcon({ className }: IconProps) {
  return (
    <svg className={className} {...base}>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="2.8" />
    </svg>
  );
}

export function SettingsIcon({ className }: IconProps) {
  return (
    <svg className={className} {...base}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3.5v2.2M12 18.3v2.2M20.5 12h-2.2M5.7 12H3.5M17.7 6.3l-1.5 1.5M7.8 16.2l-1.5 1.5M17.7 17.7l-1.5-1.5M7.8 7.8 6.3 6.3" />
    </svg>
  );
}

export function FolderIcon({ className }: IconProps) {
  return (
    <svg className={className} {...base}>
      <path d="M3.5 6.5a1.5 1.5 0 0 1 1.5-1.5h4l2 2.5h8a1.5 1.5 0 0 1 1.5 1.5v8.5a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5z" />
    </svg>
  );
}

export function PlayIcon({ className }: IconProps) {
  return (
    <svg className={className} {...base} fill="currentColor" stroke="none">
      <path d="M6.5 4.5v15l13-7.5z" />
    </svg>
  );
}

export function EditIcon({ className }: IconProps) {
  return (
    <svg className={className} {...base}>
      <path d="M15.5 4.5 19.5 8.5 8 20H4v-4z" />
      <path d="M14 6 18 10" />
    </svg>
  );
}

export function MinimizeIcon({ className }: IconProps) {
  return (
    <svg className={className} {...base}>
      <path d="M5 12h14" />
    </svg>
  );
}

export function MaximizeIcon({ className }: IconProps) {
  return (
    <svg className={className} {...base}>
      <rect x="5.5" y="5.5" width="13" height="13" rx="1" />
    </svg>
  );
}

export function RestoreIcon({ className }: IconProps) {
  return (
    <svg className={className} {...base}>
      <rect x="7.5" y="7.5" width="11" height="11" rx="1" />
      <path d="M9.5 7.5V6a1 1 0 0 1 1-1H18a1 1 0 0 1 1 1v7.5a1 1 0 0 1-1 1H17" />
    </svg>
  );
}

export function CloseIcon({ className }: IconProps) {
  return (
    <svg className={className} {...base}>
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

export function HelpCircleIcon({ className }: IconProps) {
  return (
    <svg className={className} {...base}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M9.3 9.3a2.7 2.7 0 0 1 5.2 1c0 1.7-2.5 1.9-2.5 3.5" />
      <circle cx="12" cy="16.8" r="0.3" fill="currentColor" />
    </svg>
  );
}

export function KeyIcon({ className }: IconProps) {
  return (
    <svg className={className} {...base}>
      <circle cx="7.5" cy="15.5" r="4" />
      <path d="M10.3 12.7 20 3M16.5 6.5l3 3M13.7 9.3l2.3 2.3" />
    </svg>
  );
}

export function UndoIcon({ className }: IconProps) {
  return (
    <svg className={className} {...base}>
      <path d="M4.5 9.5H11a6 6 0 1 1-5.2 9" />
      <path d="M4.5 4.5v5h5" />
    </svg>
  );
}

export function TrashIcon({ className }: IconProps) {
  return (
    <svg className={className} {...base}>
      <path d="M4.5 7h15" />
      <path d="M9.5 7V5a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 14.5 5v2" />
      <path d="M6.5 7v12a1.5 1.5 0 0 0 1.5 1.5h8a1.5 1.5 0 0 0 1.5-1.5V7" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}
