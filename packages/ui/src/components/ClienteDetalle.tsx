import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@heroui/react';
import { isTauri } from '@tauri-apps/api/core';
import { openPath } from '@tauri-apps/plugin-opener';
import { fetchClients, type ClientWithTaskCount } from '../lib/clientsClient';
import { fetchTasks, taskExportUrl, importTaskBundle, type TaskRow } from '../lib/tasksClient';
import { fetchConnections, testTransport, testDatabaseConnection, type ConnectionsData } from '../lib/connectionsClient';
import { downloadRunUrl, fetchBackups, fetchRuns, type RunRow } from '../lib/runsClient';
import { runTaskNow, testTaskConnection, testTaskCompatibility } from '../lib/statusClient';
import type { ConnectionTestResult, DirectDumpCompatibilityResult } from 'engine-core';
import { StatusChip } from './StatusChip';
import { Switch } from './Switch';
import { IconButton, IconLinkButton } from './IconButton';
import { DownloadIcon, EditIcon, FolderIcon, PlayIcon, PulseIcon, CheckCircleIcon } from './icons';
import { formatRetention, formatDateTime, formatDuration, formatSize, formatSchedule } from '../lib/format';
import { primaryPillStyle } from '../lib/pillStyles';
import { TaskCreateWizard } from './TaskCreateWizard';
import { TaskEditModal } from './TaskEditModal';
import { ConnectionEditModal } from './ConnectionEditModal';
import { ConnectionCreateModal } from './ConnectionCreateModal';
import type { ConnectionRow } from './Conexiones';

const STRATEGY_LABEL: Record<string, string> = {
  fetch_existing: 'SFTP existente',
  remote_dump: 'SSH remoto',
  direct_dump: 'Conexión directa a BD',
};

type Tab = 'tareas' | 'conexiones' | 'backups' | 'historial';

const BACKUPS_PAGE_SIZE = 20;

interface RowActionState {
  busy?: boolean;
  testResult?: ConnectionTestResult;
  compatibilityResult?: DirectDumpCompatibilityResult;
  actionError?: string;
}

function TabBar({ active, onChange, counts }: { active: Tab; onChange: (tab: Tab) => void; counts: Record<Tab, number> }) {
  const tabs: { id: Tab; label: string }[] = [
    { id: 'tareas', label: 'Tareas' },
    { id: 'conexiones', label: 'Conexiones' },
    { id: 'backups', label: 'Backups' },
    { id: 'historial', label: 'Historial' },
  ];
  return (
    <div className="flex flex-1 gap-1" style={{ borderColor: 'var(--border)' }}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => onChange(tab.id)}
          className="px-3 py-2 text-sm font-medium"
          style={{
            color: active === tab.id ? 'var(--foreground)' : 'var(--muted)',
            borderBottom: active === tab.id ? '2px solid var(--accent)' : '2px solid transparent',
          }}
        >
          {tab.label} ({counts[tab.id]})
        </button>
      ))}
    </div>
  );
}

export function ClienteDetalle({ clientId, onBack }: { clientId: string; onBack: () => void }) {
  const [client, setClient] = useState<ClientWithTaskCount | null>(null);
  const [tasks, setTasks] = useState<TaskRow[] | null>(null);
  const [connections, setConnections] = useState<ConnectionsData | null>(null);
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [backups, setBackups] = useState<RunRow[] | null>(null);
  const [backupsTotal, setBackupsTotal] = useState(0);
  const [backupsPage, setBackupsPage] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [actionState, setActionState] = useState<Record<string, RowActionState>>({});
  const [activeTab, setActiveTab] = useState<Tab>('tareas');
  const [showInactive, setShowInactive] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [showCreateConnection, setShowCreateConnection] = useState(false);
  const [editingTask, setEditingTask] = useState<TaskRow | null>(null);
  const [editingConnectionRow, setEditingConnectionRow] = useState<ConnectionRow | null>(null);
  const [folderError, setFolderError] = useState<string | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importResult, setImportResult] = useState<Awaited<ReturnType<typeof importTaskBundle>> | null>(null);
  const importFileInputRef = useRef<HTMLInputElement>(null);

  async function handleImportTaskFile(file: File) {
    setImportBusy(true);
    setImportResult(null);
    try {
      const text = await file.text();
      const bundle = JSON.parse(text);
      const result = await importTaskBundle(clientId, bundle);
      setImportResult(result);
      if (result.taskId) await refresh();
    } catch (err) {
      setImportResult({
        taskId: null,
        transportCreated: false,
        databaseConnectionCreated: false,
        secretsNeedingReentry: [],
        errors: [err instanceof Error ? err.message : String(err)],
      });
    } finally {
      setImportBusy(false);
      if (importFileInputRef.current) importFileInputRef.current.value = '';
    }
  }

  async function handleOpenFolder(path: string) {
    setFolderError(null);
    try {
      await openPath(path);
    } catch (err) {
      setFolderError(`No se pudo abrir la carpeta (¿existe todavía en disco?): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const loadBackups = useCallback(
    async (page: number) => {
      try {
        const { runs: pageRuns, total } = await fetchBackups({ clientId, limit: BACKUPS_PAGE_SIZE, offset: page * BACKUPS_PAGE_SIZE });
        setBackups(pageRuns);
        setBackupsTotal(total);
        setBackupsPage(page);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'No se pudo conectar con el motor de backups.');
      }
    },
    [clientId]
  );

  useEffect(() => {
    loadBackups(0);
  }, [loadBackups]);

  function patchAction(id: string, patch: RowActionState) {
    setActionState((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }

  const refresh = useCallback(async () => {
    try {
      const [clients, allTasks, allConnections, clientRuns] = await Promise.all([
        fetchClients({ includeInactive: true }),
        fetchTasks({ includeInactive: true }),
        fetchConnections({ includeInactive: true }),
        fetchRuns({ clientId, limit: 15 }),
      ]);
      setClient(clients.find((c) => c.id === clientId) ?? null);
      setTasks(allTasks.filter((t) => t.clientId === clientId));
      setConnections(allConnections);
      setRuns(clientRuns);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo conectar con el motor de backups.');
    }
  }, [clientId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function handleRun(taskId: string) {
    patchAction(taskId, { busy: true, actionError: undefined });
    try {
      await runTaskNow(taskId);
      patchAction(taskId, { busy: false });
      await refresh();
    } catch (err) {
      patchAction(taskId, { busy: false, actionError: err instanceof Error ? err.message : String(err) });
    }
  }

  async function handleTestTask(taskId: string) {
    patchAction(taskId, { busy: true, actionError: undefined, testResult: undefined, compatibilityResult: undefined });
    try {
      const result = await testTaskConnection(taskId);
      patchAction(taskId, { busy: false, testResult: result });
    } catch (err) {
      patchAction(taskId, { busy: false, actionError: err instanceof Error ? err.message : String(err) });
    }
  }

  async function handleTestTaskCompatibility(taskId: string) {
    patchAction(taskId, { busy: true, actionError: undefined, testResult: undefined, compatibilityResult: undefined });
    try {
      const result = await testTaskCompatibility(taskId);
      patchAction(taskId, { busy: false, compatibilityResult: result });
    } catch (err) {
      patchAction(taskId, { busy: false, actionError: err instanceof Error ? err.message : String(err) });
    }
  }

  async function handleTestConnection(id: string, kind: 'transport' | 'database', trustHost?: boolean) {
    patchAction(id, { busy: true, actionError: undefined, testResult: undefined });
    try {
      const result = kind === 'transport' ? await testTransport(id, trustHost) : await testDatabaseConnection(id);
      patchAction(id, { busy: false, testResult: result });
    } catch (err) {
      patchAction(id, { busy: false, actionError: err instanceof Error ? err.message : String(err) });
    }
  }

  const clientTransports = connections?.transports.filter((t) => t.clientId === clientId) ?? [];
  const clientDbConnections = connections?.databaseConnections.filter((d) => d.clientId === clientId) ?? [];
  const connectionRows: ConnectionRow[] = [
    ...clientTransports.map((t): ConnectionRow => ({ kind: 'transport', id: t.id, data: t })),
    ...clientDbConnections.map((d): ConnectionRow => ({ kind: 'database', id: d.id, data: d })),
  ];
  const visibleTasks = tasks?.filter((t) => showInactive || t.isActive) ?? null;
  const visibleConnectionRows = connectionRows.filter((r) => showInactive || r.data.isActive);

  return (
    <div className="max-w-[1600px] px-10 py-8">
      <button type="button" className="mb-4 text-sm hover:underline" style={{ color: 'var(--muted)' }} onClick={onBack}>
        ← Volver a Clientes
      </button>

      {error && (
        <div
          className="mb-4 rounded-md border px-4 py-3 text-sm"
          style={{ borderColor: 'var(--danger)', color: 'var(--danger)', backgroundColor: 'color-mix(in oklab, var(--danger) 10%, transparent)' }}
        >
          {error}
        </div>
      )}

      {client && (
        <>
          <header className="mb-6">
            <h1 className="text-2xl font-semibold">
              {client.name}
              {!client.isActive && (
                <span className="ml-2 text-sm font-normal" style={{ color: 'var(--muted)' }}>
                  (inactivo)
                </span>
              )}
            </h1>
            {client.description && (
              <p className="text-sm" style={{ color: 'var(--muted)' }}>
                {client.description}
              </p>
            )}
            <p className="mt-1 flex items-center gap-1.5 text-xs" style={{ color: 'var(--muted)' }}>
              {client.localBasePath} · Retención: {formatRetention(client.retentionCount, client.retentionDays)}
              {isTauri() && (
                <IconButton
                  icon={<FolderIcon />}
                  label="Abrir carpeta local"
                  onPress={() => handleOpenFolder(client.localBasePath)}
                />
              )}
            </p>
            {folderError && (
              <p className="mt-1 text-xs" style={{ color: 'var(--danger)' }}>
                {folderError}
              </p>
            )}
          </header>

          <div className="mb-4 flex items-center justify-between border-b" style={{ borderColor: 'var(--border)' }}>
            <TabBar
              active={activeTab}
              onChange={setActiveTab}
              counts={{ tareas: visibleTasks?.length ?? 0, conexiones: visibleConnectionRows.length, backups: backupsTotal, historial: runs?.length ?? 0 }}
            />
            <div className="mb-1.5 flex items-center gap-3">
              {(activeTab === 'tareas' || activeTab === 'conexiones') && (
                <Switch checked={showInactive} onChange={() => setShowInactive((v) => !v)} label="Mostrar inactivas" />
              )}
              {activeTab === 'tareas' && (
                <>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="rounded-full px-4"
                    isDisabled={importBusy}
                    onPress={() => importFileInputRef.current?.click()}
                  >
                    {importBusy ? 'Importando…' : 'Importar tarea'}
                  </Button>
                  <input
                    ref={importFileInputRef}
                    type="file"
                    accept="application/json"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) handleImportTaskFile(file);
                    }}
                  />
                  <Button size="sm" className="rounded-full px-4" style={primaryPillStyle} onPress={() => setShowCreate(true)}>
                    + Agregar backup
                  </Button>
                </>
              )}
              {activeTab === 'conexiones' && (
                <Button size="sm" className="rounded-full px-4" style={primaryPillStyle} onPress={() => setShowCreateConnection(true)}>
                  + Nueva conexión
                </Button>
              )}
            </div>
          </div>

          {activeTab === 'tareas' && importResult && (
            <div
              className="mb-4 rounded-md border px-4 py-3 text-sm"
              style={{
                borderColor: importResult.errors.length > 0 ? 'var(--danger)' : 'var(--success)',
                backgroundColor: `color-mix(in oklab, ${importResult.errors.length > 0 ? 'var(--danger)' : 'var(--success)'} 10%, transparent)`,
              }}
            >
              {importResult.taskId ? (
                <span style={{ color: 'var(--success)' }}>Tarea importada correctamente.</span>
              ) : (
                <span style={{ color: 'var(--danger)' }}>No se pudo importar: {importResult.errors.join('; ')}</span>
              )}
              {importResult.secretsNeedingReentry.length > 0 && (
                <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
                  Hay que volver a ingresar: {importResult.secretsNeedingReentry.join('; ')}
                </p>
              )}
            </div>
          )}

          {activeTab === 'tareas' &&
            (visibleTasks && visibleTasks.length > 0 ? (
              <div className="overflow-x-auto rounded-xl border" style={{ borderColor: 'var(--border)' }}>
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="text-left" style={{ color: 'var(--muted)' }}>
                      <th className="px-4 py-2 font-medium">Nombre</th>
                      <th className="px-4 py-2 font-medium">Estrategia</th>
                      <th className="px-4 py-2 font-medium">Horario</th>
                      <th className="px-4 py-2 font-medium">Acciones</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleTasks.map((task) => {
                      const state = actionState[task.id];
                      return (
                        <tr key={task.id} style={{ borderTop: '1px solid var(--separator)', opacity: task.isActive ? 1 : 0.55 }}>
                          <td className="px-4 py-2.5 font-medium">{task.name}</td>
                          <td className="px-4 py-2.5" style={{ color: 'var(--muted)' }}>
                            {STRATEGY_LABEL[task.strategy] ?? task.strategy}
                          </td>
                          <td className="px-4 py-2.5" style={{ color: 'var(--muted)' }}>
                            {formatSchedule(task)}
                          </td>
                          <td className="px-4 py-2.5">
                            {task.isActive && (
                              <div className="flex items-center gap-2">
                                <Button
                                  size="sm"
                                  className="rounded-full px-3"
                                  style={primaryPillStyle}
                                  isDisabled={Boolean(state?.busy)}
                                  onPress={() => handleRun(task.id)}
                                >
                                  <span className="flex items-center gap-1.5">
                                    <PlayIcon className="h-3.5 w-3.5" />
                                    Ejecutar ahora
                                  </span>
                                </Button>
                                <IconButton
                                  icon={<PulseIcon />}
                                  label="Probar conexión"
                                  disabled={Boolean(state?.busy)}
                                  onPress={() => handleTestTask(task.id)}
                                />
                                {task.strategy === 'direct_dump' && (
                                  <IconButton
                                    icon={<CheckCircleIcon />}
                                    label="Probar compatibilidad (versión + herramienta)"
                                    disabled={Boolean(state?.busy)}
                                    onPress={() => handleTestTaskCompatibility(task.id)}
                                  />
                                )}
                                <IconButton icon={<EditIcon />} label="Editar" onPress={() => setEditingTask(task)} />
                                <IconLinkButton
                                  icon={<DownloadIcon />}
                                  label="Exportar (conexión + tarea, para adjuntar a otro cliente)"
                                  href={taskExportUrl(task.id)}
                                />
                                {state?.testResult && (
                                  <span className="text-xs" style={{ color: state.testResult.ok ? 'var(--success)' : 'var(--danger)' }}>
                                    {state.testResult.ok ? 'OK' : state.testResult.message}
                                  </span>
                                )}
                                {state?.compatibilityResult && (
                                  <span className="text-xs" style={{ color: state.compatibilityResult.ok ? 'var(--success)' : 'var(--danger)' }}>
                                    {state.compatibilityResult.ok ? 'Compatible' : state.compatibilityResult.message}
                                  </span>
                                )}
                                {state?.actionError && (
                                  <span className="text-xs" style={{ color: 'var(--danger)' }}>
                                    {state.actionError}
                                  </span>
                                )}
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm" style={{ color: 'var(--muted)' }}>
                Este cliente no tiene tareas todavía.
              </p>
            ))}

          {activeTab === 'conexiones' &&
            (visibleConnectionRows.length > 0 ? (
              <div className="overflow-x-auto rounded-xl border" style={{ borderColor: 'var(--border)' }}>
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="text-left" style={{ color: 'var(--muted)' }}>
                      <th className="px-4 py-2 font-medium">Nombre</th>
                      <th className="px-4 py-2 font-medium">Tipo</th>
                      <th className="px-4 py-2 font-medium">Host</th>
                      <th className="px-4 py-2 font-medium">Acciones</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleConnectionRows.map((row) => {
                      const state = actionState[row.id];
                      return (
                        <tr key={row.id} style={{ borderTop: '1px solid var(--separator)', opacity: row.data.isActive ? 1 : 0.55 }}>
                          <td className="px-4 py-2.5 font-medium">{row.data.name}</td>
                          <td className="px-4 py-2.5" style={{ color: 'var(--muted)' }}>
                            {row.kind === 'transport' ? row.data.type.toUpperCase() : row.data.engine}
                          </td>
                          <td className="px-4 py-2.5" style={{ color: 'var(--muted)' }}>
                            {row.data.host}:{row.data.port}
                          </td>
                          <td className="px-4 py-2.5">
                            {row.data.isActive && (
                              <div className="flex items-center gap-2">
                                <IconButton
                                  icon={<PulseIcon />}
                                  label="Probar conexión"
                                  disabled={Boolean(state?.busy)}
                                  onPress={() => handleTestConnection(row.id, row.kind)}
                                />
                                <IconButton icon={<EditIcon />} label="Editar" onPress={() => setEditingConnectionRow(row)} />
                                {state?.testResult && !state.testResult.unknownHost && (
                                  <span className="text-xs" style={{ color: state.testResult.ok ? 'var(--success)' : 'var(--danger)' }}>
                                    {state.testResult.ok ? 'OK' : state.testResult.message}
                                  </span>
                                )}
                                {state?.testResult?.unknownHost && (
                                  <span
                                    className="flex flex-wrap items-center gap-2 text-xs"
                                    style={{ color: state.testResult.unknownHost.previousFingerprintSha256 ? 'var(--danger)' : 'var(--warning)' }}
                                  >
                                    {state.testResult.unknownHost.previousFingerprintSha256
                                      ? `⚠ La clave del host cambió — ahora ${state.testResult.unknownHost.fingerprintSha256}, antes ${state.testResult.unknownHost.previousFingerprintSha256}`
                                      : `Host desconocido — ${state.testResult.unknownHost.fingerprintSha256}`}
                                    <Button
                                      size="sm"
                                      className="rounded-full px-3"
                                      style={primaryPillStyle}
                                      isDisabled={state.busy}
                                      onPress={() => handleTestConnection(row.id, row.kind, true)}
                                    >
                                      Confiar y probar de nuevo
                                    </Button>
                                  </span>
                                )}
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm" style={{ color: 'var(--muted)' }}>
                Este cliente no tiene conexiones todavía.
              </p>
            ))}

          {activeTab === 'backups' &&
            (backups && backups.length > 0 ? (
              <>
                <div className="overflow-x-auto rounded-xl border" style={{ borderColor: 'var(--border)' }}>
                  <table className="w-full border-collapse text-sm">
                    <thead>
                      <tr className="text-left" style={{ color: 'var(--muted)' }}>
                        <th className="px-4 py-2 font-medium">Tarea</th>
                        <th className="px-4 py-2 font-medium">Fecha</th>
                        <th className="px-4 py-2 font-medium">Tamaño</th>
                        <th className="px-4 py-2 font-medium">Estado</th>
                        <th className="px-4 py-2 font-medium"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {backups.map((run) => (
                        <tr key={run.id} style={{ borderTop: '1px solid var(--separator)' }}>
                          <td className="px-4 py-2.5" style={{ color: 'var(--muted)' }}>
                            {run.taskName ?? '—'}
                          </td>
                          <td className="px-4 py-2.5">{formatDateTime(run.startedAt)}</td>
                          <td className="px-4 py-2.5" style={{ color: 'var(--muted)' }}>
                            {formatSize(run.sizeBytes)}
                          </td>
                          <td className="px-4 py-2.5">
                            <StatusChip status={run.status} />
                          </td>
                          <td className="px-4 py-2.5">
                            <IconLinkButton icon={<DownloadIcon />} label="Descargar backup" href={downloadRunUrl(run.id)} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="mt-3 flex items-center justify-between text-sm" style={{ color: 'var(--muted)' }}>
                  <span>
                    {backupsPage * BACKUPS_PAGE_SIZE + 1}–{Math.min((backupsPage + 1) * BACKUPS_PAGE_SIZE, backupsTotal)} de {backupsTotal}
                  </span>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="rounded-full px-3"
                      isDisabled={backupsPage === 0}
                      onPress={() => loadBackups(backupsPage - 1)}
                    >
                      Anterior
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="rounded-full px-3"
                      isDisabled={(backupsPage + 1) * BACKUPS_PAGE_SIZE >= backupsTotal}
                      onPress={() => loadBackups(backupsPage + 1)}
                    >
                      Siguiente
                    </Button>
                  </div>
                </div>
              </>
            ) : (
              <p className="text-sm" style={{ color: 'var(--muted)' }}>
                Este cliente todavía no tiene backups guardados.
              </p>
            ))}

          {activeTab === 'historial' &&
            (runs && runs.length > 0 ? (
              <div className="overflow-x-auto rounded-xl border" style={{ borderColor: 'var(--border)' }}>
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="text-left" style={{ color: 'var(--muted)' }}>
                      <th className="px-4 py-2 font-medium">Tarea</th>
                      <th className="px-4 py-2 font-medium">Estado</th>
                      <th className="px-4 py-2 font-medium">Inicio</th>
                      <th className="px-4 py-2 font-medium">Duración</th>
                      <th className="px-4 py-2 font-medium">Tamaño</th>
                      <th className="px-4 py-2 font-medium"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.map((run) => (
                      <tr key={run.id} style={{ borderTop: '1px solid var(--separator)' }}>
                        <td className="px-4 py-2.5" style={{ color: 'var(--muted)' }}>
                          {run.taskName ?? '—'}
                        </td>
                        <td className="px-4 py-2.5">
                          <StatusChip status={run.status} />
                        </td>
                        <td className="px-4 py-2.5">{formatDateTime(run.startedAt)}</td>
                        <td className="px-4 py-2.5" style={{ color: 'var(--muted)' }}>
                          {formatDuration(run.durationMs)}
                        </td>
                        <td className="px-4 py-2.5" style={{ color: 'var(--muted)' }}>
                          {formatSize(run.sizeBytes)}
                        </td>
                        <td className="px-4 py-2.5">
                          {run.localPath && (
                            <IconLinkButton icon={<DownloadIcon />} label="Descargar backup" href={downloadRunUrl(run.id)} />
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm" style={{ color: 'var(--muted)' }}>
                Todavía no hay ejecuciones registradas para este cliente.
              </p>
            ))}
        </>
      )}

      {showCreate && connections && (
        <TaskCreateWizard
          connections={connections}
          fixedClientId={clientId}
          onClose={() => setShowCreate(false)}
          onCreated={refresh}
        />
      )}

      {editingTask && <TaskEditModal task={editingTask} onClose={() => setEditingTask(null)} onSaved={refresh} />}

      {showCreateConnection && connections && (
        <ConnectionCreateModal
          clients={connections.clients}
          fixedClientId={clientId}
          onClose={() => setShowCreateConnection(false)}
          onCreated={refresh}
        />
      )}

      {editingConnectionRow && connections && (
        <ConnectionEditModal
          row={editingConnectionRow}
          clients={connections.clients}
          onClose={() => setEditingConnectionRow(null)}
          onSaved={refresh}
        />
      )}
    </div>
  );
}
