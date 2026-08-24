import { Fragment, useCallback, useEffect, useState } from 'react';
import { downloadRunUrl, fetchRuns, type RunRow } from '../lib/runsClient';
import { fetchTasks, type TaskRow } from '../lib/tasksClient';
import { formatDateTime, formatDuration, formatSize } from '../lib/format';
import { StatusChip } from './StatusChip';
import { IconButton, IconLinkButton } from './IconButton';
import { DownloadIcon, EyeIcon } from './icons';

const RUN_LIMIT = 200;

export function Historial() {
  const [tasks, setTasks] = useState<TaskRow[] | null>(null);
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedClientId, setSelectedClientId] = useState('');
  const [selectedTaskId, setSelectedTaskId] = useState('');
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);

  useEffect(() => {
    fetchTasks({ includeInactive: true })
      .then(setTasks)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const refresh = useCallback(async (clientId: string, taskId: string) => {
    try {
      const rows = await fetchRuns({
        clientId: clientId || undefined,
        taskId: taskId || undefined,
        limit: RUN_LIMIT,
      });
      setRuns(rows);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo conectar con el motor de backups.');
    }
  }, []);

  useEffect(() => {
    refresh(selectedClientId, selectedTaskId);
  }, [refresh, selectedClientId, selectedTaskId]);

  const clients = tasks
    ? Array.from(new Map(tasks.map((t) => [t.clientId, t.clientName])).entries()).sort((a, b) => a[1].localeCompare(b[1]))
    : [];
  const tasksForSelectedClient = tasks
    ? tasks.filter((t) => !selectedClientId || t.clientId === selectedClientId).sort((a, b) => a.name.localeCompare(b.name))
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
            {runs == null ? 'Cargando…' : `${runs.length} ejecución${runs.length === 1 ? '' : 'es'}${runs.length === RUN_LIMIT ? ' (últimas)' : ''}`}
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

      {runs && runs.length === 0 && !error && (
        <p style={{ color: 'var(--muted)' }}>No hay ejecuciones registradas todavía.</p>
      )}

      {runs && runs.length > 0 && (
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
              {runs.map((run) => {
                const expanded = expandedRunId === run.id;
                return (
                  <Fragment key={run.id}>
                    <tr style={{ borderTop: '1px solid var(--separator)' }}>
                      <td className="px-4 py-2.5 font-medium">{run.clientName ?? '—'}</td>
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
                        <div className="flex items-center gap-1">
                          {run.localPath && (
                            <IconLinkButton icon={<DownloadIcon />} label="Descargar backup" href={downloadRunUrl(run.id)} />
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
                    {expanded && run.errorMessage && (
                      <tr style={{ backgroundColor: 'color-mix(in oklab, var(--muted) 8%, transparent)' }}>
                        <td colSpan={7} className="px-4 py-2 text-xs" style={{ color: 'var(--danger)', fontFamily: 'monospace' }}>
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
      )}
    </div>
  );
}
