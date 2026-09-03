import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@heroui/react';
import { isTauri } from '@tauri-apps/api/core';
import { openPath } from '@tauri-apps/plugin-opener';
import { fetchClients, type ClientWithTaskCount } from '../lib/clientsClient';
import { fetchTasks, importTaskBundle, type TaskRow } from '../lib/tasksClient';
import {
  fetchFileBackupTasks,
  fetchFileBackupRuns,
  restoreFileBackupRun,
  deleteFileBackupRun,
  type FileBackupRun,
} from '../lib/fileBackupClient';
import { mergeTasks } from '../lib/unifiedTasks';
import { mergeRuns, toUnifiedDbRun, toUnifiedFileRun } from '../lib/unifiedRuns';
import {
  fetchConnections,
  testTransport,
  testDatabaseConnection,
  deactivateTransport,
  reactivateTransport,
  deactivateDatabaseConnection,
  reactivateDatabaseConnection,
  type ConnectionsData,
} from '../lib/connectionsClient';
import { deleteBackupRun, downloadRunUrl, fetchBackups, fetchRuns, type RunRow } from '../lib/runsClient';
import type { ConnectionTestResult, DirectDumpCompatibilityResult } from 'engine-core';
import { StatusChip } from './StatusChip';
import { ProgressBar } from './ProgressBar';
import { isLiveProgress } from '../lib/progress';
import { Switch } from './Switch';
import { IconButton, IconLinkButton } from './IconButton';
import { DownloadIcon, EditIcon, EyeIcon, FolderIcon, PulseIcon, TrashIcon, UndoIcon } from './icons';
import { KindBadge } from './KindBadge';
import { formatRetention, formatDateTime, formatDuration, formatSize, formatConnectionTestVersions } from '../lib/format';
import { primaryPillStyle, dangerPillStyle } from '../lib/pillStyles';
import { TaskCreateWizard } from './TaskCreateWizard';
import { UnifiedTaskTable } from './UnifiedTaskTable';
import { AddBackupChoiceModal } from './AddBackupChoiceModal';
import { FileTaskCreateModal } from './FileTaskCreateModal';
import { ConnectionEditModal } from './ConnectionEditModal';
import { ConnectionCreateModal } from './ConnectionCreateModal';
import { FileBackupsPanel } from './FileBackupsPanel';
import { ReplicationPanel } from './ReplicationPanel';
import { BackupSetsSection } from './BackupSetsSection';
import { BackupSetBadge } from './BackupSetBadge';
import type { ConnectionRow } from './Conexiones';

type Tab = 'tareas' | 'conexiones' | 'backups' | 'historial' | 'archivos' | 'copia-externa';

const BACKUPS_PAGE_SIZE = 20;

interface RowActionState {
  busy?: 'run' | 'test' | 'compatibility' | 'toggle' | 'scheduler' | 'unscheduler';
  testResult?: ConnectionTestResult;
  compatibilityResult?: DirectDumpCompatibilityResult;
  actionError?: string;
  schedulerMessage?: string;
}

function TabBar({ active, onChange, counts }: { active: Tab; onChange: (tab: Tab) => void; counts: Partial<Record<Tab, number>> }) {
  const tabs: { id: Tab; label: string }[] = [
    { id: 'tareas', label: 'Tareas' },
    { id: 'conexiones', label: 'Conexiones' },
    { id: 'archivos', label: 'Repositorio' },
    { id: 'backups', label: 'Backups' },
    { id: 'historial', label: 'Historial' },
    { id: 'copia-externa', label: 'Copia externa' },
  ];
  return (
    <div className="flex flex-1 gap-1 overflow-x-auto" style={{ borderColor: 'var(--border)' }}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => onChange(tab.id)}
          className="whitespace-nowrap px-3 py-2 text-sm font-medium"
          style={{
            color: active === tab.id ? 'var(--foreground)' : 'var(--muted)',
            borderBottom: active === tab.id ? '2px solid var(--accent)' : '2px solid transparent',
          }}
        >
          {tab.label}
          {counts[tab.id] != null ? ` (${counts[tab.id]})` : ''}
        </button>
      ))}
    </div>
  );
}

export function ClienteDetalle({ clientId, onBack }: { clientId: string; onBack: () => void }) {
  const [client, setClient] = useState<ClientWithTaskCount | null>(null);
  const [tasks, setTasks] = useState<TaskRow[] | null>(null);
  const [fileTasks, setFileTasks] = useState<Awaited<ReturnType<typeof fetchFileBackupTasks>> | null>(null);
  const [connections, setConnections] = useState<ConnectionsData | null>(null);
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [fileRuns, setFileRuns] = useState<FileBackupRun[] | null>(null);
  const [backups, setBackups] = useState<RunRow[] | null>(null);
  const [backupsTotal, setBackupsTotal] = useState(0);
  const [backupsPage, setBackupsPage] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [actionState, setActionState] = useState<Record<string, RowActionState>>({});
  const [activeTab, setActiveTab] = useState<Tab>('tareas');
  const [showInactive, setShowInactive] = useState(false);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [choosingKind, setChoosingKind] = useState(false);
  const [creatingKind, setCreatingKind] = useState<'db' | 'file' | null>(null);
  const [showCreateConnection, setShowCreateConnection] = useState(false);
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

  const [deletingRunId, setDeletingRunId] = useState<string | null>(null);

  async function handleDeleteBackup(runId: string, afterDelete: () => Promise<void>) {
    if (!window.confirm('¿Eliminar este backup? Esta acción no se puede deshacer.')) return;
    setDeletingRunId(runId);
    try {
      await deleteBackupRun(runId);
      await afterDelete();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingRunId(null);
    }
  }

  async function handleDeleteFileRun(runId: string, afterDelete: () => Promise<void>) {
    if (!window.confirm('¿Eliminar este snapshot? El espacio en disco recién se libera en el próximo prune.')) return;
    setDeletingRunId(runId);
    try {
      await deleteFileBackupRun(runId);
      await afterDelete();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingRunId(null);
    }
  }

  async function handleRestoreFileRun(runId: string) {
    const target = window.prompt('Carpeta donde restaurar este snapshot completo:');
    if (!target) return;
    setDeletingRunId(runId);
    try {
      const r = await restoreFileBackupRun(runId, target);
      window.alert(
        r.warning
          ? `Restaurado con una advertencia (${r.filesRestored} archivos): ${r.warning}`
          : `Restaurado: ${r.filesRestored} archivos en ${r.targetDir}`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingRunId(null);
    }
  }

  function patchAction(id: string, patch: RowActionState) {
    setActionState((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }

  const refresh = useCallback(async () => {
    try {
      const [clients, allTasks, clientFileTasks, allConnections, clientRuns, clientFileRuns] = await Promise.all([
        fetchClients({ includeInactive: true }),
        fetchTasks({ includeInactive: true }),
        fetchFileBackupTasks(clientId, { includeInactive: true }),
        fetchConnections({ includeInactive: true }),
        fetchRuns({ clientId, limit: 30 }),
        fetchFileBackupRuns({ clientId, limit: 30 }),
      ]);
      setClient(clients.find((c) => c.id === clientId) ?? null);
      setTasks(allTasks.filter((t) => t.clientId === clientId));
      setFileTasks(clientFileTasks);
      setConnections(allConnections);
      setRuns(clientRuns);
      setFileRuns(clientFileRuns);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo conectar con el motor de backups.');
    }
  }, [clientId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const hasLiveRun =
    (runs ?? []).some((r) => isLiveProgress(r.status, r.progress)) ||
    (fileRuns ?? []).some((r) => isLiveProgress(r.status, r.progress));
  useEffect(() => {
    if (!hasLiveRun) return;
    const id = setInterval(refresh, 3000);
    return () => clearInterval(id);
  }, [hasLiveRun, refresh]);

  async function handleTestConnection(id: string, kind: 'transport' | 'database', trustHost?: boolean) {
    patchAction(id, { busy: 'test', actionError: undefined, testResult: undefined });
    try {
      const result = kind === 'transport' ? await testTransport(id, trustHost) : await testDatabaseConnection(id);
      patchAction(id, { busy: undefined, testResult: result });
    } catch (err) {
      patchAction(id, { busy: undefined, actionError: err instanceof Error ? err.message : String(err) });
    }
  }

  async function handleToggleConnection(row: ConnectionRow) {
    if (row.data.isActive && !window.confirm(`¿Desactivar "${row.data.name}"? Las tareas que la usan fallarán limpiamente en vez de eliminarse.`)) {
      return;
    }
    patchAction(row.id, { busy: 'toggle', actionError: undefined });
    try {
      if (row.kind === 'transport') {
        await (row.data.isActive ? deactivateTransport(row.id) : reactivateTransport(row.id));
      } else {
        await (row.data.isActive ? deactivateDatabaseConnection(row.id) : reactivateDatabaseConnection(row.id));
      }
      patchAction(row.id, { busy: undefined });
      await refresh();
    } catch (err) {
      patchAction(row.id, { busy: undefined, actionError: err instanceof Error ? err.message : String(err) });
    }
  }

  const clientTransports = connections?.transports.filter((t) => t.clientId === clientId) ?? [];
  const clientDbConnections = connections?.databaseConnections.filter((d) => d.clientId === clientId) ?? [];
  const connectionRows: ConnectionRow[] = [
    ...clientTransports.map((t): ConnectionRow => ({ kind: 'transport', id: t.id, data: t })),
    ...clientDbConnections.map((d): ConnectionRow => ({ kind: 'database', id: d.id, data: d })),
  ];
  const unifiedTaskRows =
    tasks && fileTasks
      ? mergeTasks(
          tasks.filter((t) => showInactive || t.isActive),
          fileTasks.filter((t) => showInactive || t.isActive)
        )
      : null;
  const visibleConnectionRows = connectionRows.filter((r) => showInactive || r.data.isActive);

  // Historial tab: DB attempts + file runs, newest first, capped.
  const historialRows = runs && fileRuns ? mergeRuns(runs, fileRuns).slice(0, 30) : null;
  // Backups tab: keep DB pagination; file snapshots (Success/Warning with a
  // real snapshot) all show on page 0, merged and re-sorted by date.
  const fileBackupRows = (fileRuns ?? [])
    .filter((r) => (r.status === 'Success' || r.status === 'Warning') && r.snapshotId)
    .map(toUnifiedFileRun);
  const backupsRows = backups
    ? [...(backupsPage === 0 ? fileBackupRows : []), ...backups.map(toUnifiedDbRun)].sort((a, b) =>
        b.startedAt.localeCompare(a.startedAt)
      )
    : null;

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

          <BackupSetsSection clientId={clientId} />

          <div className="mb-4">
            <div className="flex border-b" style={{ borderColor: 'var(--border)' }}>
              <TabBar
                active={activeTab}
                onChange={setActiveTab}
                counts={{ tareas: unifiedTaskRows?.length ?? 0, conexiones: visibleConnectionRows.length, backups: backupsTotal, historial: historialRows?.length ?? 0 }}
              />
            </div>
            {(activeTab === 'tareas' || activeTab === 'conexiones') && (
              <div className="mt-2.5 flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
                <Switch checked={showInactive} onChange={() => setShowInactive((v) => !v)} label="Mostrar inactivas" />
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
                    <Button size="sm" className="rounded-full px-4" style={primaryPillStyle} onPress={() => setChoosingKind(true)}>
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
            )}
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
            (unifiedTaskRows && unifiedTaskRows.length > 0 ? (
              <UnifiedTaskTable
                rows={unifiedTaskRows}
                showClientColumn={false}
                onChanged={() => Promise.all([refresh(), loadBackups(backupsPage)])}
              />
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
                            {row.data.isActive ? (
                              <div className="flex items-center gap-2">
                                <IconButton
                                  icon={<PulseIcon />}
                                  label="Probar conexión"
                                  disabled={Boolean(state?.busy)}
                                  onPress={() => handleTestConnection(row.id, row.kind)}
                                />
                                <IconButton icon={<EditIcon />} label="Editar" onPress={() => setEditingConnectionRow(row)} />
                                <Button
                                  size="sm"
                                  className="rounded-full px-3"
                                  style={dangerPillStyle}
                                  isDisabled={state?.busy === 'toggle'}
                                  onPress={() => handleToggleConnection(row)}
                                >
                                  {state?.busy === 'toggle' ? '…' : 'Desactivar'}
                                </Button>
                                {state?.testResult && !state.testResult.unknownHost && (
                                  <span className="text-xs" style={{ color: state.testResult.ok ? 'var(--success)' : 'var(--danger)' }}>
                                    {state.testResult.ok ? 'Conexión OK' : 'Conexión fallida'}
                                    {state.testResult.message ? ` — ${state.testResult.message}` : ''}
                                    {state.testResult.latencyMs != null ? ` (${state.testResult.latencyMs} ms)` : ''}
                                    {formatConnectionTestVersions(state.testResult)}
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
                                      isDisabled={Boolean(state.busy)}
                                      onPress={() => handleTestConnection(row.id, row.kind, true)}
                                    >
                                      Confiar y probar de nuevo
                                    </Button>
                                  </span>
                                )}
                              </div>
                            ) : (
                              <div className="flex items-center gap-2">
                                <span className="text-xs" style={{ color: 'var(--muted)' }}>
                                  (inactiva)
                                </span>
                                <Button
                                  size="sm"
                                  className="rounded-full px-3"
                                  style={primaryPillStyle}
                                  isDisabled={state?.busy === 'toggle'}
                                  onPress={() => handleToggleConnection(row)}
                                >
                                  {state?.busy === 'toggle' ? '…' : 'Reactivar'}
                                </Button>
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

          {activeTab === 'archivos' && <FileBackupsPanel clientId={clientId} />}

          {activeTab === 'copia-externa' && <ReplicationPanel clientId={clientId} />}

          {activeTab === 'backups' &&
            (backupsRows && backupsRows.length > 0 ? (
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
                      {backupsRows.map((run) => (
                        <tr key={`${run.kind}-${run.id}`} style={{ borderTop: '1px solid var(--separator)' }}>
                          <td className="px-4 py-2.5" style={{ color: 'var(--muted)' }}>
                            {run.taskName ?? '—'}
                            <KindBadge kind={run.kind} />
                            <BackupSetBadge name={run.backupSetName} />
                          </td>
                          <td className="px-4 py-2.5">{formatDateTime(run.startedAt)}</td>
                          <td className="px-4 py-2.5" style={{ color: 'var(--muted)' }}>
                            {formatSize(run.sizeBytes)}
                          </td>
                          <td className="px-4 py-2.5">
                            <StatusChip status={run.status} />
                          </td>
                          <td className="px-4 py-2.5">
                            <div className="flex items-center gap-1">
                              {run.kind === 'db' ? (
                                <>
                                  <IconLinkButton icon={<DownloadIcon />} label="Descargar backup" href={downloadRunUrl(run.id)} />
                                  <IconButton
                                    icon={<TrashIcon />}
                                    label="Eliminar backup"
                                    tone="danger"
                                    disabled={deletingRunId === run.id}
                                    onPress={() => handleDeleteBackup(run.id, () => loadBackups(backupsPage))}
                                  />
                                </>
                              ) : (
                                <>
                                  <IconButton
                                    icon={<UndoIcon />}
                                    label="Restaurar snapshot completo"
                                    disabled={deletingRunId === run.id}
                                    onPress={() => handleRestoreFileRun(run.id)}
                                  />
                                  <IconButton
                                    icon={<TrashIcon />}
                                    label="Eliminar snapshot"
                                    tone="danger"
                                    disabled={deletingRunId === run.id}
                                    onPress={() => handleDeleteFileRun(run.id, refresh)}
                                  />
                                </>
                              )}
                            </div>
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
            (historialRows && historialRows.length > 0 ? (
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
                    {historialRows.map((run) => {
                      const expanded = expandedRunId === run.id;
                      return (
                        <Fragment key={`${run.kind}-${run.id}`}>
                          <tr style={{ borderTop: '1px solid var(--separator)' }}>
                            <td className="px-4 py-2.5" style={{ color: 'var(--muted)' }}>
                              {run.taskName ?? '—'}
                              <KindBadge kind={run.kind} />
                              <BackupSetBadge name={run.backupSetName} />
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
                              <div className="flex items-center gap-1">
                                {run.kind === 'db' && run.localFileExists && (
                                  <>
                                    <IconLinkButton icon={<DownloadIcon />} label="Descargar backup" href={downloadRunUrl(run.id)} />
                                    <IconButton
                                      icon={<TrashIcon />}
                                      label="Eliminar backup"
                                      tone="danger"
                                      disabled={deletingRunId === run.id}
                                      onPress={() => handleDeleteBackup(run.id, refresh)}
                                    />
                                  </>
                                )}
                                {run.kind === 'db' && run.hadLocalPath && !run.localFileExists && (
                                  <span className="text-xs" style={{ color: 'var(--muted)' }}>
                                    Eliminado
                                  </span>
                                )}
                                {run.kind === 'file' && run.snapshotId && (
                                  <>
                                    <IconButton
                                      icon={<UndoIcon />}
                                      label="Restaurar snapshot completo"
                                      disabled={deletingRunId === run.id}
                                      onPress={() => handleRestoreFileRun(run.id)}
                                    />
                                    <IconButton
                                      icon={<TrashIcon />}
                                      label="Eliminar snapshot"
                                      tone="danger"
                                      disabled={deletingRunId === run.id}
                                      onPress={() => handleDeleteFileRun(run.id, refresh)}
                                    />
                                  </>
                                )}
                                {run.errorMessage && (
                                  <IconButton
                                    icon={<EyeIcon />}
                                    label={expanded ? 'Ocultar error' : 'Ver error'}
                                    onPress={() => setExpandedRunId(expanded ? null : run.id)}
                                  />
                                )}
                              </div>
                            </td>
                          </tr>
                          {isLiveProgress(run.status, run.progress) && (
                            <tr>
                              <td colSpan={6} className="px-4 pb-2">
                                <ProgressBar progress={run.progress} />
                              </td>
                            </tr>
                          )}
                          {expanded && run.errorMessage && (
                            <tr style={{ backgroundColor: 'color-mix(in oklab, var(--muted) 8%, transparent)' }}>
                              <td colSpan={6} className="px-4 py-2 text-xs" style={{ color: 'var(--danger)', fontFamily: 'monospace' }}>
                                {run.errorMessage}
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
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

      {choosingKind && (
        <AddBackupChoiceModal
          onClose={() => setChoosingKind(false)}
          onChoose={(kind) => {
            setChoosingKind(false);
            setCreatingKind(kind);
          }}
        />
      )}

      {creatingKind === 'db' && connections && (
        <TaskCreateWizard
          connections={connections}
          fixedClientId={clientId}
          onClose={() => setCreatingKind(null)}
          onCreated={refresh}
        />
      )}

      {creatingKind === 'file' && (
        <FileTaskCreateModal fixedClientId={clientId} onClose={() => setCreatingKind(null)} onCreated={refresh} />
      )}

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
