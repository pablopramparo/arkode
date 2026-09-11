import { DocumentIcon, GridIcon, HelpCircleIcon, SettingsIcon, UsersIcon } from "./icons";
import { TitleBar } from "./TitleBar";
import { VaultLockChip } from "./VaultLockChip";
import { GlobalSearch } from "./GlobalSearch";
import type { ProjectTab } from "./ClienteDetalle";
import { useTraySync } from "../lib/useTraySync";
import arkodeLogo from "../assets/arkode-logo-completo.png";

export type Screen =
  | "dashboard"
  | "clientes"
  | "conexiones"
  | "tareas"
  | "historial"
  | "logs"
  | "ayuda"
  | "configuracion";

interface NavItem {
  id: Screen | string;
  label: string;
  icon: React.ReactNode;
  enabled: boolean;
}

// "Dashboard observa. Cliente administra." — Conexiones / Tareas / Historial
// were removed from the sidebar (their screens, routes and endpoints stay:
// Conexiones y Tareas se administran desde la ficha del cliente; el historial
// global vive en Logs y en el Historial de cada cliente). "Detalle de cliente"
// is a drill-down from Clientes, not its own sidebar destination.
const NAV_ITEMS: NavItem[] = [
  { id: "dashboard", label: "Dashboard", icon: <GridIcon />, enabled: true },
  { id: "clientes", label: "Clientes", icon: <UsersIcon />, enabled: true },
  { id: "logs", label: "Logs", icon: <DocumentIcon />, enabled: true },
  { id: "ayuda", label: "Ayuda", icon: <HelpCircleIcon />, enabled: true },
  {
    id: "configuracion",
    label: "Configuración",
    icon: <SettingsIcon />,
    enabled: true,
  },
];

export function AppShell({
  screen,
  onNavigate,
  onSelectClient,
  children,
}: {
  screen: Screen;
  onNavigate: (screen: Screen) => void;
  onSelectClient?: (clientId: string, projectTab?: ProjectTab, projectItemId?: string) => void;
  children: React.ReactNode;
}) {
  // Mounted here (not inside Dashboard) so the tray icon/tooltip stays
  // accurate regardless of which screen is open, or whether the window is
  // even visible — AppShell is the one thing that's always mounted.
  useTraySync();

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        <aside
          className="flex w-60 shrink-0 flex-col overflow-y-auto border-r px-3 py-5"
          style={{
            borderColor: "var(--border)",
            backgroundColor:
              "color-mix(in oklab, var(--foreground) 3%, var(--background))",
          }}
        >
        <div className="mb-4 px-2">
          <img src={arkodeLogo} alt="arkode by codebius" className="w-full" />
        </div>

        <div className="mb-3 px-2">
          <GlobalSearch onSelectClient={onSelectClient} />
        </div>

        <div className="mb-4 flex flex-wrap items-center gap-2 px-2">
          <VaultLockChip />
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

        <div className="mt-auto px-2 pt-4">
          <a
            href="https://codebius.com"
            target="_blank"
            rel="noreferrer"
            className="text-xs hover:underline"
            style={{ color: "var(--muted)" }}
          >
            arkode by codebius
          </a>
          <p
            className="mt-1 text-[10px] leading-tight"
            style={{ color: "var(--muted)", opacity: 0.8 }}
          >
            Backup your data. Not your drama.
          </p>
        </div>
        </aside>

        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
