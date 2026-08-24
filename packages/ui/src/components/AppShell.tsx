import {
  ClipboardIcon,
  ClockIcon,
  DatabaseIcon,
  DocumentIcon,
  GridIcon,
  SettingsIcon,
  UsersIcon,
} from "./icons";

export type Screen = "dashboard" | "clientes" | "conexiones";

interface NavItem {
  id: Screen | string;
  label: string;
  icon: React.ReactNode;
  enabled: boolean;
}

// Mirrors project.md's actual v1 screen list (CLAUDE.md "UX direction") —
// "Detalle de cliente" is a drill-down from Clientes, not its own sidebar
// destination, so it has no entry here.
const NAV_ITEMS: NavItem[] = [
  { id: "dashboard", label: "Dashboard", icon: <GridIcon />, enabled: true },
  { id: "clientes", label: "Clientes", icon: <UsersIcon />, enabled: true },
  { id: "conexiones", label: "Conexiones", icon: <DatabaseIcon />, enabled: true },
  { id: "tareas", label: "Tareas", icon: <ClockIcon />, enabled: false },
  {
    id: "historial",
    label: "Historial",
    icon: <ClipboardIcon />,
    enabled: false,
  },
  { id: "logs", label: "Logs", icon: <DocumentIcon />, enabled: false },
  {
    id: "configuracion",
    label: "Configuración",
    icon: <SettingsIcon />,
    enabled: false,
  },
];

export function AppShell({
  screen,
  onNavigate,
  children,
}: {
  screen: Screen;
  onNavigate: (screen: Screen) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen">
      <aside
        className="flex w-60 shrink-0 flex-col border-r px-3 py-5"
        style={{
          borderColor: "var(--border)",
          backgroundColor:
            "color-mix(in oklab, var(--foreground) 3%, var(--background))",
        }}
      >
        <div className="mb-6 flex items-center gap-3 px-2">
          <div
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-white"
            style={{ background: "linear-gradient(135deg, #38bdf8, #3b82f6, #d946ef)" }}
          >
            <DatabaseIcon className="h-5 w-5" />
          </div>
          <div className="leading-tight">
            <div className="text-sm font-semibold">Codebius</div>
            <div className="text-xs" style={{ color: "var(--muted)" }}>
              Backup Manager
            </div>
          </div>
        </div>

        <nav className="flex flex-col gap-0.5">
          {NAV_ITEMS.map((item) => {
            const isActive = item.enabled && item.id === screen;
            return (
              <button
                key={item.id}
                type="button"
                disabled={!item.enabled}
                onClick={() => item.enabled && onNavigate(item.id as Screen)}
                className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors"
                style={{
                  color: isActive
                    ? "white"
                    : item.enabled
                      ? "var(--foreground)"
                      : "var(--muted)",
                  backgroundColor: isActive ? "var(--accent)" : "transparent",
                  opacity: item.enabled ? 1 : 0.45,
                  cursor: item.enabled ? "pointer" : "not-allowed",
                }}
              >
                <span className="h-4.5 w-4.5 [&>svg]:h-[18px] [&>svg]:w-[18px]">
                  {item.icon}
                </span>
                {item.label}
              </button>
            );
          })}
        </nav>

        <div
          className="mt-auto px-2 pt-4 text-xs"
          style={{ color: "var(--muted)" }}
        >
          by codebius
        </div>
      </aside>

      <main className="flex-1">{children}</main>
    </div>
  );
}
