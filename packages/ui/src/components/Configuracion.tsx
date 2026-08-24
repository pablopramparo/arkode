import { useEffect, useRef, useState } from 'react';
import { Button } from '@heroui/react';
import type { ImportConfigResult, SystemInfo } from 'engine-core';
import { CONFIG_EXPORT_URL, fetchSystemInfo, importConfig } from '../lib/configClient';
import { primaryPillStyle } from '../lib/pillStyles';

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
  const [error, setError] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<ImportConfigResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetchSystemInfo()
      .then(setSystem)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

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

      <section>
        <h2 className="mb-2 text-sm font-semibold">Configuración de clientes</h2>
        <div className="rounded-xl border p-4" style={{ borderColor: 'var(--border)' }}>
          <div className="flex flex-wrap items-center gap-3">
            <a href={CONFIG_EXPORT_URL}>
              <Button size="sm" className="rounded-full px-4" style={primaryPillStyle}>
                Exportar todos los clientes
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
