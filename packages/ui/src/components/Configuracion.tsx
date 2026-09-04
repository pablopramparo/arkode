import { useEffect, useRef, useState } from 'react';
import { Button } from '@heroui/react';
import { isTauri } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { isEnabled as isAutostartEnabled, enable as enableAutostart, disable as disableAutostart } from '@tauri-apps/plugin-autostart';
import { check as checkForUpdate, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { getVersion } from '@tauri-apps/api/app';
import type { ImportConfigResult, SystemInfo } from 'engine-core';
import {
  configExportUrl,
  fetchSystemInfo,
  importConfig,
  fetchToolRegistry,
  registerTool,
  unregisterTool,
  downloadTool,
  detectInstalledTools,
  type ToolRegistryData,
  type ToolRegistryEngine,
  type DetectedTool,
} from '../lib/configClient';
import { fetchClients, type ClientWithTaskCount } from '../lib/clientsClient';
import { fetchDashboardStatus } from '../lib/statusClient';
import { IN_PROGRESS_RUN_STATUSES } from '../lib/tasksClient';
import { primaryPillStyle } from '../lib/pillStyles';
import { Switch } from './Switch';
import { SchedulerStatusBanner } from './SchedulerStatusBanner';
import arkodeIsotipo from '../assets/arkode-isotipo.png';

const inputStyle: React.CSSProperties = {
  backgroundColor: 'var(--background)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  padding: '5px 8px',
  color: 'var(--foreground)',
};

interface ToolRegistryField {
  key: string;
  label: string;
}

/**
 * One shared component for all three engines' version-keyed dump-tool
 * registries — the table+add-row shape is identical across postgres (two
 * path fields: pg_dump/pg_restore) and mysql/mariadb (one path field each);
 * only the field list differs, which is exactly the kind of structural
 * duplication worth collapsing (unlike the dump *clients* themselves, whose
 * actual per-engine dump/SSL logic genuinely differs and stays separate).
 */
function ToolRegistrySection({
  title,
  description,
  fields,
  rows,
  onRegister,
  onUnregister,
  onDownload,
  exactVersionHint,
}: {
  title: string;
  description: string;
  fields: ToolRegistryField[];
  rows: Record<string, Record<string, string>>;
  onRegister: (version: string, values: Record<string, string>) => Promise<void>;
  onUnregister: (version: string) => Promise<void>;
  /** postgres/mariadb only — see downloadTool.ts's own doc comment for why mysql is excluded from auto-download entirely. */
  onDownload?: (version: string, exactVersion: string) => Promise<void>;
  /** Placeholder text for the "exact version" field, shown only when onDownload is set. */
  exactVersionHint?: string;
}) {
  const [mode, setMode] = useState<'path' | 'download'>('path');
  const [version, setVersion] = useState('');
  const [exactVersion, setExactVersion] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit =
    mode === 'download'
      ? version.trim().length > 0 && exactVersion.trim().length > 0
      : version.trim().length > 0 && fields.every((f) => (values[f.key] ?? '').trim().length > 0);

  async function handlePick(fieldKey: string) {
    const selected = await openDialog({
      directory: false,
      multiple: false,
      filters: [{ name: 'Ejecutable', extensions: ['exe'] }],
    });
    if (typeof selected === 'string') setValues((prev) => ({ ...prev, [fieldKey]: selected }));
  }

  async function handleRegister() {
    setBusy(true);
    setError(null);
    try {
      if (mode === 'download') {
        await onDownload!(version.trim(), exactVersion.trim());
        setExactVersion('');
      } else {
        await onRegister(version.trim(), values);
        setValues({});
      }
      setVersion('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleUnregister(v: string) {
    setError(null);
    try {
      await onUnregister(v);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="rounded-xl border p-4" style={{ borderColor: 'var(--border)' }}>
      <h3 className="text-sm font-medium">{title}</h3>
      <p className="mb-3 text-xs" style={{ color: 'var(--muted)' }}>
        {description}
      </p>

      {Object.keys(rows).length > 0 && (
        <table className="mb-3 w-full border-collapse text-sm">
          <thead>
            <tr className="text-left" style={{ color: 'var(--muted)' }}>
              <th className="py-1 pr-3 font-medium">Versión</th>
              {fields.map((f) => (
                <th key={f.key} className="py-1 pr-3 font-medium">
                  {f.label}
                </th>
              ))}
              <th className="py-1 font-medium" />
            </tr>
          </thead>
          <tbody>
            {Object.entries(rows).map(([v, paths]) => (
              <tr key={v} style={{ borderTop: '1px solid var(--separator)' }}>
                <td className="py-1.5 pr-3 font-medium">{v}</td>
                {fields.map((f) => (
                  <td key={f.key} className="py-1.5 pr-3" style={{ fontFamily: 'monospace', fontSize: '0.75rem', color: 'var(--muted)' }}>
                    {paths[f.key] ?? '—'}
                  </td>
                ))}
                <td className="py-1.5">
                  <Button size="sm" variant="ghost" className="rounded-full px-2 text-xs" onPress={() => handleUnregister(v)}>
                    Quitar
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {onDownload && (
        <div className="mb-2 flex gap-2">
          {(
            [
              { value: 'path' as const, label: 'Ruta local' },
              { value: 'download' as const, label: 'Descargar automáticamente' },
            ]
          ).map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setMode(opt.value)}
              className="rounded-full px-3 py-1 text-xs font-medium"
              style={{
                backgroundColor: mode === opt.value ? 'var(--accent)' : 'var(--surface-secondary)',
                color: mode === opt.value ? 'white' : 'var(--muted)',
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <label className="text-xs" style={{ color: 'var(--muted)' }}>
            Versión
          </label>
          <input style={{ ...inputStyle, width: 90 }} placeholder="ej: 9.1" value={version} onChange={(e) => setVersion(e.target.value)} />
        </div>
        {mode === 'download' ? (
          <div className="flex flex-col gap-1">
            <label className="text-xs" style={{ color: 'var(--muted)' }}>
              Versión exacta a descargar
            </label>
            <input
              style={{ ...inputStyle, width: 160 }}
              placeholder={exactVersionHint}
              value={exactVersion}
              onChange={(e) => setExactVersion(e.target.value)}
            />
          </div>
        ) : (
          fields.map((f) => (
            <div key={f.key} className="flex flex-col gap-1">
              <label className="text-xs" style={{ color: 'var(--muted)' }}>
                {f.label}
              </label>
              <div className="flex gap-1">
                <input
                  style={{ ...inputStyle, width: 220 }}
                  value={values[f.key] ?? ''}
                  onChange={(e) => setValues((prev) => ({ ...prev, [f.key]: e.target.value }))}
                />
                {isTauri() && (
                  <Button size="sm" variant="ghost" className="shrink-0 rounded-full px-2 text-xs" onPress={() => handlePick(f.key)}>
                    Elegir…
                  </Button>
                )}
              </div>
            </div>
          ))
        )}
        <Button size="sm" className="rounded-full px-4" style={primaryPillStyle} isDisabled={busy || !canSubmit} onPress={handleRegister}>
          {busy ? (mode === 'download' ? 'Descargando…' : 'Registrando…') : mode === 'download' ? 'Descargar y registrar' : 'Registrar'}
        </Button>
      </div>
      {mode === 'download' && (
        <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
          Puede tardar varios minutos según el tamaño de la descarga.
        </p>
      )}

      {error && (
        <p className="mt-2 text-xs" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      )}
    </div>
  );
}

function ToolStatusBadge({
  path,
  exists,
  source,
}: {
  path: string | null;
  exists: boolean;
  source?: 'env' | 'bundled' | 'bundled-fallback' | null;
}) {
  const { label, color } = path == null
    ? { label: 'No configurada', color: 'var(--muted)' }
    : !exists
      ? { label: 'Configurada, no encontrada', color: 'var(--danger)' }
      : source === 'bundled' || source === 'bundled-fallback'
        ? { label: source === 'bundled' ? 'Incluida' : 'Incluida (MariaDB)', color: 'var(--success)' }
        : { label: 'Disponible', color: 'var(--success)' };
  return (
    <span
      className="rounded-full px-2 py-0.5 text-xs font-medium"
      style={{ backgroundColor: `color-mix(in oklab, ${color} 15%, transparent)`, color }}
    >
      {label}
    </span>
  );
}

const monoStyle: React.CSSProperties = { fontFamily: 'monospace', fontSize: '0.8125rem', color: 'var(--muted)' };

/**
 * What a detected binary can be registered as, if anything. A `mysqldump`
 * whose --version says "MariaDB" is really a MariaDB tool, so it routes to
 * the mariadb registry; a `pg_dump` needs its `pg_restore` sibling from the
 * same folder to register the pair.
 */
function registerTarget(
  tool: DetectedTool,
  all: DetectedTool[]
): { engine: ToolRegistryEngine; version: string; values: Record<string, string>; note?: string } | null {
  if (!tool.majorMinor) return null;
  const isMaria = (tool.version ?? '').toLowerCase().includes('mariadb');
  if (tool.kind === 'pg_dump') {
    const dir = tool.path.slice(0, Math.max(tool.path.lastIndexOf('\\'), tool.path.lastIndexOf('/')));
    const restore = all.find(
      (t) => t.kind === 'pg_restore' && t.path.toLowerCase().startsWith(dir.toLowerCase())
    );
    if (!restore) return null;
    return {
      engine: 'postgres',
      version: tool.majorMinor,
      values: { pgDumpPath: tool.path, pgRestorePath: restore.path },
    };
  }
  if (tool.kind === 'mariadb-dump' || (tool.kind === 'mysqldump' && isMaria)) {
    return { engine: 'mariadb', version: tool.majorMinor, values: { mariaDbDumpPath: tool.path } };
  }
  if (tool.kind === 'mysqldump') {
    return { engine: 'mysql', version: tool.majorMinor, values: { mysqldumpPath: tool.path } };
  }
  return null;
}

function DetectToolsSection({ onRegistered }: { onRegistered: () => void }) {
  const [tools, setTools] = useState<DetectedTool[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyPath, setBusyPath] = useState<string | null>(null);

  async function scan() {
    setScanning(true);
    setError(null);
    try {
      setTools(await detectInstalledTools());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setScanning(false);
    }
  }

  async function register(tool: DetectedTool) {
    const target = registerTarget(tool, tools ?? []);
    if (!target) return;
    setBusyPath(tool.path);
    setError(null);
    try {
      await registerTool(target.engine, target.version, target.values);
      onRegistered();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyPath(null);
    }
  }

  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">Detectar herramientas instaladas</h2>
        <Button size="sm" variant="ghost" className="rounded-full px-3 text-xs" onPress={scan} isDisabled={scanning}>
          {scanning ? 'Buscando…' : tools ? 'Volver a buscar' : 'Buscar en el equipo'}
        </Button>
      </div>
      <p className="mb-3 text-xs" style={{ color: 'var(--muted)' }}>
        arkode ya trae los binarios de PostgreSQL y de MariaDB — esto es solo para usar una instalación local de una versión
        específica (WAMP, XAMPP, un MySQL/MariaDB propio) en vez de la incluida.
      </p>
      {error && (
        <p className="mb-2 text-xs" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      )}
      {tools && tools.length === 0 && (
        <p className="text-xs" style={{ color: 'var(--muted)' }}>
          No se encontró ninguna instalación en las ubicaciones habituales.
        </p>
      )}
      {tools && tools.length > 0 && (
        <div className="overflow-x-auto rounded-xl border" style={{ borderColor: 'var(--border)' }}>
          <table className="w-full text-left text-sm">
            <thead style={{ color: 'var(--muted)' }}>
              <tr>
                <th className="px-4 py-2 font-medium">Herramienta</th>
                <th className="px-4 py-2 font-medium">Versión</th>
                <th className="px-4 py-2 font-medium">Ruta</th>
                <th className="px-4 py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {tools.map((tool) => {
                const target = registerTarget(tool, tools);
                return (
                  <tr key={tool.path} style={{ borderTop: '1px solid var(--separator)' }}>
                    <td className="px-4 py-2.5">{tool.kind}</td>
                    <td className="px-4 py-2.5" style={monoStyle}>
                      {tool.majorMinor ?? '—'}
                    </td>
                    <td className="px-4 py-2.5" style={monoStyle}>
                      {tool.path}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {target ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="rounded-full px-3 text-xs"
                          onPress={() => register(tool)}
                          isDisabled={busyPath === tool.path}
                        >
                          {busyPath === tool.path
                            ? 'Registrando…'
                            : `Registrar (${target.engine} ${target.version})`}
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

type ConfigTab = 'general' | 'herramientas' | 'clientes';

function TabBar({ active, onChange }: { active: ConfigTab; onChange: (tab: ConfigTab) => void }) {
  const tabs: { id: ConfigTab; label: string }[] = [
    { id: 'general', label: 'General' },
    { id: 'herramientas', label: 'Herramientas' },
    { id: 'clientes', label: 'Clientes' },
  ];
  return (
    <div className="mb-6 flex gap-1" style={{ borderBottom: '1px solid var(--separator)' }}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => onChange(tab.id)}
          className="px-3 py-2 text-sm font-medium"
          style={{
            color: active === tab.id ? 'var(--foreground)' : 'var(--muted)',
            borderBottom: active === tab.id ? '2px solid var(--accent)' : '2px solid transparent',
            marginBottom: -1,
          }}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function Configuracion() {
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [clients, setClients] = useState<ClientWithTaskCount[] | null>(null);
  const [exportClientId, setExportClientId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<ImportConfigResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [toolRegistry, setToolRegistry] = useState<ToolRegistryData | null>(null);
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [autostartBusy, setAutostartBusy] = useState(false);
  const [updateCheck, setUpdateCheck] = useState<'idle' | 'checking' | 'none' | 'available' | 'downloading' | 'ready'>('idle');
  const [availableUpdate, setAvailableUpdate] = useState<Update | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<ConfigTab>('general');

  const refreshToolRegistry = () => fetchToolRegistry().then(setToolRegistry);

  useEffect(() => {
    fetchSystemInfo()
      .then(setSystem)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
    fetchClients()
      .then(setClients)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
    refreshToolRegistry().catch((err) => setError(err instanceof Error ? err.message : String(err)));
    if (isTauri()) {
      isAutostartEnabled()
        .then(setAutostart)
        .catch((err) => setError(err instanceof Error ? err.message : String(err)));
      getVersion()
        .then(setAppVersion)
        .catch((err) => setError(err instanceof Error ? err.message : String(err)));
    }
  }, []);

  async function handleToggleAutostart() {
    setAutostartBusy(true);
    setError(null);
    try {
      if (autostart) await disableAutostart();
      else await enableAutostart();
      setAutostart(await isAutostartEnabled());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAutostartBusy(false);
    }
  }

  async function handleCheckForUpdate() {
    setUpdateCheck('checking');
    setUpdateError(null);
    try {
      const update = await checkForUpdate();
      if (update?.available) {
        setAvailableUpdate(update);
        setUpdateCheck('available');
      } else {
        setUpdateCheck('none');
      }
    } catch (err) {
      setUpdateError(err instanceof Error ? err.message : String(err));
      setUpdateCheck('idle');
    }
  }

  async function handleInstallUpdate() {
    if (!availableUpdate) return;

    // The installer stops the scheduler service and force-kills engine-cli.exe
    // before touching any file — so installing now would interrupt anything
    // running. Warn (don't block: the user can still choose to proceed).
    try {
      const rows = await fetchDashboardStatus();
      const running = rows.filter((r) => (IN_PROGRESS_RUN_STATUSES as string[]).includes(r.status));
      if (running.length > 0) {
        const names = running.map((r) => `${r.client} · ${r.task}`).join('\n  ');
        const proceed = window.confirm(
          `Hay ${running.length === 1 ? 'un backup' : `${running.length} backups`} en curso:\n  ${names}\n\n` +
            'Instalar la actualización ahora lo va a interrumpir (queda como "Interrumpida" y se reintenta en la próxima corrida). ¿Instalar igual?'
        );
        if (!proceed) return;
      }
    } catch {
      // If /status isn't reachable, don't get in the way of the update.
    }

    setUpdateCheck('downloading');
    setUpdateError(null);
    try {
      await availableUpdate.downloadAndInstall();
      setUpdateCheck('ready');
    } catch (err) {
      setUpdateError(err instanceof Error ? err.message : String(err));
      setUpdateCheck('available');
    }
  }

  async function handleRegisterTool(engine: ToolRegistryEngine, version: string, values: Record<string, string>) {
    await registerTool(engine, version, values);
    await refreshToolRegistry();
  }

  async function handleUnregisterTool(engine: ToolRegistryEngine, version: string) {
    await unregisterTool(engine, version);
    await refreshToolRegistry();
  }

  async function handleDownloadTool(engine: 'postgres' | 'mariadb', version: string, exactVersion: string) {
    await downloadTool(engine, version, exactVersion);
    await refreshToolRegistry();
  }

  const exportUrl = exportClientId ? `${configExportUrl()}?clientId=${exportClientId}` : configExportUrl();

  async function handleFileSelected(file: File) {
    setImportBusy(true);
    setImportError(null);
    setImportResult(null);
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const result = await importConfig(data);
      setImportResult(result);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err));
    } finally {
      setImportBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  return (
    <div className="max-w-[1600px] px-10 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">Configuración</h1>
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
          Versión y actualizaciones, diagnóstico de herramientas, y respaldo/restauración de la configuración de clientes.
        </p>
      </header>

      {error && (
        <div
          className="mb-4 rounded-md border px-4 py-3 text-sm"
          style={{ borderColor: 'var(--danger)', color: 'var(--danger)', backgroundColor: 'color-mix(in oklab, var(--danger) 10%, transparent)' }}
        >
          {error}
        </div>
      )}

      <TabBar active={activeTab} onChange={setActiveTab} />

      {activeTab === 'general' && (
        <div className="flex flex-col gap-4">
          {isTauri() ? (
            <>
              <section className="flex items-center gap-4 rounded-xl border p-4" style={{ borderColor: 'var(--border)' }}>
                <img src={arkodeIsotipo} alt="" className="h-12 w-12 shrink-0" />
                <div>
                  <h2 className="text-sm font-semibold">arkode by codebius</h2>
                  <p className="text-sm" style={{ color: 'var(--muted)' }}>
                    Versión {appVersion ?? '—'}
                  </p>
                  <a
                    href="https://codebius.com"
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs hover:underline"
                    style={{ color: 'var(--muted)' }}
                  >
                    codebius.com
                  </a>
                </div>
              </section>

              <section className="rounded-xl border p-4" style={{ borderColor: 'var(--border)' }}>
                <h2 className="mb-3 text-sm font-semibold">Actualizaciones</h2>
                <div className="flex flex-wrap items-center gap-3">
                  {updateCheck === 'idle' || updateCheck === 'none' ? (
                    <Button size="sm" variant="ghost" className="rounded-full px-4" onPress={handleCheckForUpdate}>
                      Buscar actualizaciones
                    </Button>
                  ) : updateCheck === 'checking' ? (
                    <span className="text-xs" style={{ color: 'var(--muted)' }}>
                      Buscando…
                    </span>
                  ) : updateCheck === 'available' ? (
                    <>
                      <span className="text-xs" style={{ color: 'var(--success)' }}>
                        Nueva versión disponible: {availableUpdate?.version}
                      </span>
                      <Button size="sm" className="rounded-full px-4" style={primaryPillStyle} onPress={handleInstallUpdate}>
                        Descargar e instalar
                      </Button>
                    </>
                  ) : updateCheck === 'downloading' ? (
                    <span className="text-xs" style={{ color: 'var(--muted)' }}>
                      Descargando e instalando…
                    </span>
                  ) : (
                    <>
                      <span className="text-xs" style={{ color: 'var(--success)' }}>
                        Instalada. Hay que reiniciar arkode para aplicarla.
                      </span>
                      <Button size="sm" className="rounded-full px-4" style={primaryPillStyle} onPress={() => relaunch()}>
                        Reiniciar ahora
                      </Button>
                    </>
                  )}
                </div>
                {updateCheck === 'none' && (
                  <p className="mt-2 text-xs" style={{ color: 'var(--muted)' }}>
                    Ya tenés la última versión.
                  </p>
                )}
                {updateError && (
                  <p className="mt-2 text-xs" style={{ color: 'var(--danger)' }}>
                    {updateError}
                  </p>
                )}
              </section>

              <section className="rounded-xl border p-4" style={{ borderColor: 'var(--border)' }}>
                <h2 className="mb-3 text-sm font-semibold">Servicio de backups</h2>
                <SchedulerStatusBanner />
                <p className="text-xs" style={{ color: 'var(--muted)' }}>
                  Un servicio de Windows (<code>arkode-scheduler</code>) ejecuta los backups programados — de base de
                  datos y de archivos — con la app cerrada o no, y con o sin sesión iniciada. Lo instala y arranca el
                  instalador; si alguna vez se detiene, usá <strong>Reiniciar</strong> (o <strong>Reinstalar</strong> si
                  se rompió). Cambiar el horario de una tarea no requiere nada acá — el servicio lo toma en el próximo
                  ciclo.
                </p>
              </section>

              <section className="rounded-xl border p-4" style={{ borderColor: 'var(--border)' }}>
                <h2 className="mb-3 text-sm font-semibold">Inicio automático</h2>
                <Switch
                  checked={autostart ?? false}
                  onChange={handleToggleAutostart}
                  label={autostartBusy ? 'Actualizando…' : 'Iniciar arkode automáticamente al iniciar Windows'}
                />
                <p className="mt-2 text-xs" style={{ color: 'var(--muted)' }}>
                  Esto solo afecta si el Dashboard se abre solo al prender la PC — los backups programados corren igual
                  (los ejecuta el servicio <code>arkode-scheduler</code>, no depende de esta app).
                </p>
              </section>
            </>
          ) : (
            <p className="text-sm" style={{ color: 'var(--muted)' }}>
              Versión, actualizaciones e inicio automático solo están disponibles corriendo la app de escritorio (Tauri), no en este modo de desarrollo web.
            </p>
          )}
        </div>
      )}

      {activeTab === 'herramientas' && (
        <div className="flex flex-col gap-8">
          <section>
            <h2 className="mb-2 text-sm font-semibold">Ubicación de datos</h2>
            {system && (
              <div className="rounded-xl border p-4" style={{ borderColor: 'var(--border)' }}>
                <div className="grid grid-cols-[140px_1fr] gap-y-2 text-sm">
                  <span style={{ color: 'var(--muted)' }}>Carpeta de datos</span>
                  <span style={monoStyle}>{system.appDataDir}</span>
                  <span style={{ color: 'var(--muted)' }}>Base de datos</span>
                  <span style={monoStyle}>{system.dbFilePath}</span>
                  <span style={{ color: 'var(--muted)' }}>Logs</span>
                  <span style={monoStyle}>{system.logsDir}</span>
                </div>
              </div>
            )}
          </section>

          <section>
            <h2 className="mb-2 text-sm font-semibold">Herramientas de línea de comandos (direct_dump)</h2>
            {system && (
              <div className="overflow-x-auto rounded-xl border" style={{ borderColor: 'var(--border)' }}>
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="text-left" style={{ color: 'var(--muted)' }}>
                      <th className="px-4 py-2 font-medium">Herramienta</th>
                      <th className="px-4 py-2 font-medium">Variable de entorno</th>
                      <th className="px-4 py-2 font-medium">Ruta configurada</th>
                      <th className="px-4 py-2 font-medium">Estado</th>
                    </tr>
                  </thead>
                  <tbody>
                    {system.tools.map((tool) => (
                      <tr key={tool.envVar} style={{ borderTop: '1px solid var(--separator)' }}>
                        <td className="px-4 py-2.5">{tool.label}</td>
                        <td className="px-4 py-2.5" style={monoStyle}>
                          {tool.envVar}
                        </td>
                        <td className="px-4 py-2.5" style={monoStyle}>
                          {tool.path ?? '—'}
                        </td>
                        <td className="px-4 py-2.5">
                          <ToolStatusBadge path={tool.path} exists={tool.exists} source={tool.source} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="mt-2 text-xs" style={{ color: 'var(--muted)' }}>
              Solo aplica a tareas direct_dump. arkode incluye PostgreSQL y MariaDB, así que normalmente no hay que configurar
              nada; las variables de entorno son para forzar una ruta propia.
            </p>
          </section>

          <DetectToolsSection onRegistered={refreshToolRegistry} />

          <section>
            <h2 className="mb-2 text-sm font-semibold">Herramientas por versión (direct_dump)</h2>
            <p className="mb-3 text-xs" style={{ color: 'var(--muted)' }}>
              Cuando un cliente usa una versión que no coincide con la ruta por defecto de arriba, registrá acá la herramienta
              correcta para esa versión — se elige automáticamente según la versión detectada del servidor, sin tocar la tarea.
            </p>
            {toolRegistry && (
              <div className="flex flex-col gap-4">
                <ToolRegistrySection
                  title="PostgreSQL"
                  description='Versión mayor (ej. "18", "15", o "9.6" para versiones previas a la 10).'
                  fields={[
                    { key: 'pgDumpPath', label: 'pg_dump' },
                    { key: 'pgRestorePath', label: 'pg_restore' },
                  ]}
                  rows={toolRegistry.postgres as unknown as Record<string, Record<string, string>>}
                  onRegister={(version, values) => handleRegisterTool('postgres', version, values)}
                  onUnregister={(version) => handleUnregisterTool('postgres', version)}
                  onDownload={(version, exactVersion) => handleDownloadTool('postgres', version, exactVersion)}
                  exactVersionHint='ej: 18.6-1'
                />
                <ToolRegistrySection
                  title="MySQL"
                  description='Versión mayor.menor (ej. "8.0", "9.1").'
                  fields={[{ key: 'mysqldumpPath', label: 'mysqldump' }]}
                  rows={toolRegistry.mysql as unknown as Record<string, Record<string, string>>}
                  onRegister={(version, values) => handleRegisterTool('mysql', version, values)}
                  onUnregister={(version) => handleUnregisterTool('mysql', version)}
                />
                <ToolRegistrySection
                  title="MariaDB"
                  description='Versión mayor.menor (ej. "10.11", "11.5").'
                  fields={[{ key: 'mariaDbDumpPath', label: 'mariadb-dump' }]}
                  rows={toolRegistry.mariadb as unknown as Record<string, Record<string, string>>}
                  onRegister={(version, values) => handleRegisterTool('mariadb', version, values)}
                  onUnregister={(version) => handleUnregisterTool('mariadb', version)}
                  onDownload={(version, exactVersion) => handleDownloadTool('mariadb', version, exactVersion)}
                  exactVersionHint='ej: 11.5.2'
                />
              </div>
            )}
          </section>
        </div>
      )}

      {activeTab === 'clientes' && (
        <section>
          <h2 className="mb-2 text-sm font-semibold">Configuración de clientes</h2>
          <div className="rounded-xl border p-4" style={{ borderColor: 'var(--border)' }}>
            <div className="flex flex-wrap items-center gap-3">
              <select
                style={{
                  backgroundColor: 'var(--background)',
                  border: '1px solid var(--border)',
                  borderRadius: 9999,
                  padding: '6px 14px',
                  color: 'var(--foreground)',
                }}
                value={exportClientId}
                onChange={(e) => setExportClientId(e.target.value)}
              >
                <option value="">Todos los clientes</option>
                {clients?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <a href={exportUrl}>
                <Button size="sm" className="rounded-full px-4" style={primaryPillStyle}>
                  {exportClientId ? 'Exportar cliente' : 'Exportar todos'}
                </Button>
              </a>
              <Button
                size="sm"
                variant="ghost"
                className="rounded-full px-4"
                isDisabled={importBusy}
                onPress={() => fileInputRef.current?.click()}
              >
                {importBusy ? 'Importando…' : 'Importar desde archivo'}
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept="application/json"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleFileSelected(file);
                }}
              />
            </div>
            <p className="mt-2 text-xs" style={{ color: 'var(--muted)' }}>
              El export nunca incluye contraseñas ni passphrases — hay que volver a cargarlas después de importar.
              Importar siempre crea clientes nuevos; si ya existe un cliente con ese nombre, ese ítem falla sin afectar al resto.
            </p>

            {importError && (
              <p className="mt-3 text-sm" style={{ color: 'var(--danger)' }}>
                {importError}
              </p>
            )}

            {importResult && (
              <div className="mt-4 overflow-x-auto rounded-lg border" style={{ borderColor: 'var(--border)' }}>
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="text-left" style={{ color: 'var(--muted)' }}>
                      <th className="px-4 py-2 font-medium">Cliente</th>
                      <th className="px-4 py-2 font-medium">Resultado</th>
                      <th className="px-4 py-2 font-medium">Secretos a re-ingresar</th>
                    </tr>
                  </thead>
                  <tbody>
                    {importResult.clients.map((client) => (
                      <tr key={client.name} style={{ borderTop: '1px solid var(--separator)' }}>
                        <td className="px-4 py-2.5 font-medium">{client.name}</td>
                        <td className="px-4 py-2.5">
                          {client.errors.length > 0 ? (
                            <span style={{ color: 'var(--danger)' }}>{client.errors.join('; ')}</span>
                          ) : (
                            <span style={{ color: 'var(--success)' }}>
                              {client.transportsCreated} transporte(s), {client.databaseConnectionsCreated} conexión(es) de BD,{' '}
                              {client.tasksCreated} tarea(s) creadas
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2.5" style={{ color: 'var(--muted)' }}>
                          {client.secretsNeedingReentry.length > 0 ? client.secretsNeedingReentry.join(', ') : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
