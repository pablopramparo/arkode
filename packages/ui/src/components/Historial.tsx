import { Fragment, useCallback, useEffect, useState } from 'react';
import { deleteBackupRun, downloadRunUrl, fetchRuns } from '../lib/runsClient';
import { fetchTasks } from '../lib/tasksClient';
import {
  fetchFileBackupTasks,
  fetchFileBackupRuns,
  restoreFileBackupRun,
  deleteFileBackupRun,
} from '../lib/fileBackupClient';
import { mergeRuns, type UnifiedRunRow } from '../lib/unifiedRuns';
import { formatDateTime, formatDuration, formatSize } from '../lib/format';
import { isLiveProgress } from '../lib/progress';
import { isInterruptedRun, friendlyRunError } from '../lib/runStatus';
import { ProgressBar } from './ProgressBar';
import { StatusChip } from './StatusChip';
import { IconButton, IconLinkButton } from './IconButton';
import { DownloadIcon, EyeIcon, TrashIcon, UndoIcon } from './icons';
import { ClientLink } from './ClientLink';
import { BackupSetBadge } from './BackupSetBadge';
import { KindBadge } from './KindBadge';

const RUN_LIMIT = 200;

export function Historial({ onSelectClient }: { onSelectClient: (clientId: string) => void }) {
  const [taskOptions, setTaskOptions] = useState<{ id: string; name: string; clientId: string; clientName: string }[] | null>(null);
  const [rows, setRows] = useState<UnifiedRunRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedClientId, setSelectedClientId] = useState('');
  const [selectedTaskId, setSelectedTaskId] = useState('');
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [busyRunId, setBusyRunId] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([fetchTasks({ includeInactive: true }), fetchFileBackupTasks(undefined, { includeInactive: true })])
      .then(([db, file]) =>
        setTaskOptions([
          ...db.map((t) => ({ id: t.id, name: t.name, clientId: t.clientId, clientName: t.clientName })),
          ...file.map((t) => ({ id: t.id, name: `${t.name} (archivos)`, clientId: t.clientId, clientName: t.clientName })),
        ])
      )
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const refresh = useCallback(async (clientId: string, taskId: string) => {
    try {
      const [dbRuns, fileRuns] = await Promise.all([
        fetchRuns({ clientId: clientId || undefined, taskId: taskId || undefined, limit: RUN_LIMIT }),
        fetchFileBackupRuns({ clientId: clientId || undefined, taskId: taskId || undefined, limit: RUN_LIMIT }),
      ]);
      setRows(mergeRuns(dbRuns, fileRuns));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo conectar con el motor de backups.');
    }
  }, []);

  useEffect(() => {
    refresh(selectedClientId, selectedTaskId);
  }, [refresh, selectedClientId, selectedTaskId]);

  // While any visible run is actively reporting progress, poll fast so the
  // bar advances; otherwise don't poll at all (Historial is normally static).
  const hasLiveRun = (rows ?? []).some((r) => isLiveProgress(r.status, r.progress));
  useEffect(() => {
    if (!hasLiveRun) return;
    const id = setInterval(() => refresh(selectedClientId, selectedTaskId), 3000);
    return () => clearInterval(id);
  }, [hasLiveRun, refresh, selectedClientId, selectedTaskId]);

  async function handleDeleteDb(runId: string) {
    if (!window.confirm('¿Eliminar este backup? Esta acción no se puede deshacer.')) return;
    setBusyRunId(runId);
    try {
      await deleteBackupRun(runId);
      await refresh(selectedClientId, selectedTaskId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyRunId(null);
    }
  }

  async function handleDeleteFile(runId: string) {
    if (!window.confirm('¿Eliminar este snapshot? El espacio en disco recién se libera en el próximo prune.')) return;
    setBusyRunId(runId);
    try {
      await deleteFileBackupRun(runId);
      await refresh(selectedClientId, selectedTaskId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyRunId(null);
    }
  }

  async function handleRestoreFile(runId: string) {
    const target = window.prompt('Carpeta donde restaurar este snapshot completo:');
    if (!target) return;
    setBusyRunId(runId);
    try {
      const result = await restoreFileBackupRun(runId, target);
      window.alert(
        result.warning
          ? `Restaurado con una advertencia (${result.filesRestored} archivos): ${result.warning}`
          : `Restaurado: ${result.filesRestored} archivos en ${result.targetDir}`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyRunId(null);
    }
  }

  const clients = taskOptions
    ? Array.from(new Map(taskOptions.map((t) => [t.clientId, t.clientName])).entries()).sort((a, b) => a[1].localeCompare(b[1]))
    : [];
  const tasksForSelectedClient = taskOptions
    ? taskOptions.filter((t) => !selectedClientId || t.clientId === selectedClientId).sort((a, b) => a.name.localeCompare(b.name))
    : [];

  const inputStyle: React.CSSProperties = {
    backgroundColor: 'var(--background)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    padding: '6px 10px',
    color: 'var(--foreground)',
  };

  return (
    <div className="max-w-[1600px] px-10 py-8">
      <header className="mb-6 flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Historial</h1>
          <p className="text-sm" style={{ color: 'var(--muted)' }}>
            {rows == null ? 'Cargando…' : `${rows.length} ejecución${rows.length === 1 ? '' : 'es'}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            style={inputStyle}
            value={selectedClientId}
            onChange={(e) => {
              setSelectedClientId(e.target.value);
              setSelectedTaskId('');
            }}
          >
            <option value="">Todos los clientes</option>
            {clients.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
          <select style={inputStyle} value={selectedTaskId} onChange={(e) => setSelectedTaskId(e.target.value)}>
            <option value="">Todas las tareas</option>
            {tasksForSelectedClient.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
      </header>

      {error && (
        <div
          className="mb-4 rounded-md border px-4 py-3 text-sm"
          style={{ borderColor: 'var(--danger)', color: 'var(--danger)', backgroundColor: 'color-mix(in oklab, var(--danger) 10%, transparent)' }}
        >
          {error}
        </div>
      )}

      {rows && rows.length === 0 && !error && <p style={{ color: 'var(--muted)' }}>No hay ejecuciones registradas todavía.</p>}

      {rows && rows.length > 0 && (
        <div className="overflow-x-auto rounded-xl border" style={{ borderColor: 'var(--border)' }}>
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="text-left" style={{ color: 'var(--muted)' }}>
                <th className="px-4 py-2 font-medium">Cliente</th>
                <th className="px-4 py-2 font-medium">Tarea</th>
                <th className="px-4 py-2 font-medium">Estado</th>
                <th className="px-4 py-2 font-medium">Inicio</th>
                <th className="px-4 py-2 font-medium">Duración</th>
                <th className="px-4 py-2 font-medium">Tamaño</th>
                <th className="px-4 py-2 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((run) => {
                const expanded = expandedRunId === run.id;
                return (
                  <Fragment key={`${run.kind}-${run.id}`}>
                    <tr style={{ borderTop: '1px solid var(--separator)' }}>
                      <td className="px-4 py-2.5 font-medium">
                        {run.clientName ? <ClientLink clientId={run.clientId} name={run.clientName} onSelect={onSelectClient} /> : '—'}
                      </td>
                      <td className="px-4 py-2.5" style={{ color: 'var(--muted)' }}>
                        {run.taskName ?? '—'}
                        <KindBadge kind={run.kind} />
                        <BackupSetBadge name={run.backupSetName} />
                      </td>
                      <td className="px-4 py-2.5">
                        <StatusChip status={run.status} errorMessage={run.errorMessage} />
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
                                disabled={busyRunId === run.id}
                                onPress={() => handleDeleteDb(run.id)}
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
                                disabled={busyRunId === run.id}
                                onPress={() => handleRestoreFile(run.id)}
                              />
                              <IconButton
                                icon={<TrashIcon />}
                                label="Eliminar snapshot"
                                tone="danger"
                                disabled={busyRunId === run.id}
                                onPress={() => handleDeleteFile(run.id)}
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
                        <td colSpan={7} className="px-4 pb-2">
                          <ProgressBar progress={run.progress} />
                        </td>
                      </tr>
                    )}
                    {expanded && run.errorMessage && (
                      <tr style={{ backgroundColor: 'color-mix(in oklab, var(--muted) 8%, transparent)' }}>
                        <td
                          colSpan={7}
                          className="px-4 py-2 text-xs"
                          style={{
                            color: isInterruptedRun(run.status, run.errorMessage) ? 'var(--muted)' : 'var(--danger)',
                            fontFamily: isInterruptedRun(run.status, run.errorMessage) ? undefined : 'monospace',
                          }}
                        >
                          {friendlyRunError(run.status, run.errorMessage)}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
