import {
  ClipboardIcon,
  ClockIcon,
  DatabaseIcon,
  DocumentIcon,
  GridIcon,
  SettingsIcon,
  UsersIcon,
} from "./icons";
import arkodeLogo from "../assets/arkode-logo-completo.png";

export type Screen = "dashboard" | "clientes" | "conexiones" | "tareas" | "historial";

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
  { id: "tareas", label: "Tareas", icon: <ClockIcon />, enabled: true },
  {
    id: "historial",
    label: "Historial",
    icon: <ClipboardIcon />,
    enabled: true,
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
        <div className="mb-6 px-2">
          <img src={arkodeLogo} alt="Arkode by Codebius" className="w-full" />
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

        <a
          href="https://codebius.com"
          target="_blank"
          rel="noreferrer"
          className="mt-auto px-2 pt-4 text-xs hover:underline"
          style={{ color: "var(--muted)" }}
        >
          Arkode by Codebius
        </a>
      </aside>

      <main className="flex-1">{children}</main>
    </div>
  );
}
