import { useEffect, useRef, useState } from 'react';
import { Button } from '@heroui/react';
import { isTauri } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { isEnabled as isAutostartEnabled, enable as enableAutostart, disable as disableAutostart } from '@tauri-apps/plugin-autostart';
import type { ImportConfigResult, SystemInfo } from 'engine-core';
import {
  CONFIG_EXPORT_URL,
  fetchSystemInfo,
  importConfig,
  fetchToolRegistry,
  registerTool,
  unregisterTool,
  type ToolRegistryData,
  type ToolRegistryEngine,
} from '../lib/configClient';
import { fetchClients, type ClientWithTaskCount } from '../lib/clientsClient';
import { primaryPillStyle } from '../lib/pillStyles';
import { Switch } from './Switch';

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
}: {
  title: string;
  description: string;
  fields: ToolRegistryField[];
  rows: Record<string, Record<string, string>>;
  onRegister: (version: string, values: Record<string, string>) => Promise<void>;
  onUnregister: (version: string) => Promise<void>;
}) {
  const [version, setVersion] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = version.trim().length > 0 && fields.every((f) => (values[f.key] ?? '').trim().length > 0);

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
      await onRegister(version.trim(), values);
      setVersion('');
      setValues({});
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

      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <label className="text-xs" style={{ color: 'var(--muted)' }}>
            Versión
          </label>
          <input style={{ ...inputStyle, width: 90 }} placeholder="ej: 9.1" value={version} onChange={(e) => setVersion(e.target.value)} />
        </div>
        {fields.map((f) => (
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
        ))}
        <Button size="sm" className="rounded-full px-4" style={primaryPillStyle} isDisabled={busy || !canSubmit} onPress={handleRegister}>
          {busy ? 'Registrando…' : 'Registrar'}
        </Button>
      </div>

      {error && (
        <p className="mt-2 text-xs" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      )}
    </div>
  );
}

function ToolStatusBadge({ path, exists }: { path: string | null; exists: boolean }) {
  const { label, color } = path == null
    ? { label: 'No configurada', color: 'var(--muted)' }
    : exists
      ? { label: 'Disponible', color: 'var(--success)' }
      : { label: 'Configurada, no encontrada', color: 'var(--danger)' };
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

  async function handleRegisterTool(engine: ToolRegistryEngine, version: string, values: Record<string, string>) {
    await registerTool(engine, version, values);
    await refreshToolRegistry();
  }

  async function handleUnregisterTool(engine: ToolRegistryEngine, version: string) {
    await unregisterTool(engine, version);
    await refreshToolRegistry();
  }

  const exportUrl = exportClientId ? `${CONFIG_EXPORT_URL}?clientId=${exportClientId}` : CONFIG_EXPORT_URL;

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
          Diagnóstico del sistema y respaldo/restauración de la configuración de clientes.
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

      {isTauri() && (
        <section className="mb-8">
          <h2 className="mb-2 text-sm font-semibold">Aplicación</h2>
          <div className="rounded-xl border p-4" style={{ borderColor: 'var(--border)' }}>
            <Switch
              checked={autostart ?? false}
              onChange={handleToggleAutostart}
              label={autostartBusy ? 'Actualizando…' : 'Iniciar Arkode automáticamente al iniciar Windows'}
            />
            <p className="mt-2 text-xs" style={{ color: 'var(--muted)' }}>
              Esto solo afecta si el Dashboard se abre solo al prender la PC — los backups programados corren igual
              como tarea de Windows, con la app cerrada o no.
            </p>
          </div>
        </section>
      )}

      <section className="mb-8">
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

      <section className="mb-8">
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
                      <ToolStatusBadge path={tool.path} exists={tool.exists} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-xs" style={{ color: 'var(--muted)' }}>
          Solo aplica a tareas direct_dump. Estas rutas se configuran hoy por variable de entorno, no desde esta pantalla.
        </p>
      </section>

      <section className="mb-8">
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
            />
          </div>
        )}
      </section>

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
    </div>
  );
}
