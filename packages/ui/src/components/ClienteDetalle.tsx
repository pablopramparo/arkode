import { useCallback, useEffect, useState } from 'react';
import { Button } from '@heroui/react';
import { fetchClients, type ClientWithTaskCount } from '../lib/clientsClient';
import { fetchTasks, type TaskRow } from '../lib/tasksClient';
import { fetchConnections, testTransport, testDatabaseConnection, type ConnectionsData } from '../lib/connectionsClient';
import { fetchRuns, type RunRow } from '../lib/runsClient';
import { runTaskNow, testTaskConnection } from '../lib/statusClient';
import type { ConnectionTestResult } from 'engine-core';
import { StatusChip } from './StatusChip';
import { IconButton } from './IconButton';
import { PulseIcon } from './icons';
import { formatRetention, formatDateTime, formatDuration, formatSize } from '../lib/format';
import { primaryPillStyle } from '../lib/pillStyles';

const STRATEGY_LABEL: Record<string, string> = {
  fetch_existing: 'SFTP existente',
  remote_dump: 'SSH remoto',
  direct_dump: 'Conexión directa a BD',
};

interface RowActionState {
  busy?: boolean;
  testResult?: ConnectionTestResult;
  actionError?: string;
}

export function ClienteDetalle({ clientId, onBack }: { clientId: string; onBack: () => void }) {
  const [client, setClient] = useState<ClientWithTaskCount | null>(null);
  const [tasks, setTasks] = useState<TaskRow[] | null>(null);
  const [connections, setConnections] = useState<ConnectionsData | null>(null);
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionState, setActionState] = useState<Record<string, RowActionState>>({});

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
    patchAction(taskId, { busy: true, actionError: undefined, testResult: undefined });
    try {
      const result = await testTaskConnection(taskId);
      patchAction(taskId, { busy: false, testResult: result });
    } catch (err) {
      patchAction(taskId, { busy: false, actionError: err instanceof Error ? err.message : String(err) });
    }
  }

  async function handleTestConnection(id: string, kind: 'transport' | 'database') {
    patchAction(id, { busy: true, actionError: undefined, testResult: undefined });
    try {
      const result = kind === 'transport' ? await testTransport(id) : await testDatabaseConnection(id);
      patchAction(id, { busy: false, testResult: result });
    } catch (err) {
      patchAction(id, { busy: false, actionError: err instanceof Error ? err.message : String(err) });
    }
  }

  const clientTransports = connections?.transports.filter((t) => t.clientId === clientId) ?? [];
  const clientDbConnections = connections?.databaseConnections.filter((d) => d.clientId === clientId) ?? [];

  return (
    <div className="max-w-[1600px] px-10 py-8">
      <button
        type="button"
        className="mb-4 text-sm hover:underline"
        style={{ color: 'var(--muted)' }}
        onClick={onBack}
      >
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
            <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
              {client.localBasePath} · Retención: {formatRetention(client.retentionCount, client.retentionDays)}
            </p>
          </header>

          <section className="mb-8">
            <h2 className="mb-2 text-sm font-semibold">Tareas ({tasks?.length ?? 0})</h2>
            {tasks && tasks.length > 0 ? (
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
                    {tasks.map((task) => {
                      const state = actionState[task.id];
                      return (
                        <tr key={task.id} style={{ borderTop: '1px solid var(--separator)', opacity: task.isActive ? 1 : 0.55 }}>
                          <td className="px-4 py-2.5 font-medium">{task.name}</td>
                          <td className="px-4 py-2.5" style={{ color: 'var(--muted)' }}>
                            {STRATEGY_LABEL[task.strategy] ?? task.strategy}
                          </td>
                          <td className="px-4 py-2.5" style={{ color: 'var(--muted)' }}>
                            {task.scheduleTime ?? 'Sin programar'}
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
                                  Ejecutar ahora
                                </Button>
                                <IconButton
                                  icon={<PulseIcon />}
                                  label="Probar conexión"
                                  disabled={Boolean(state?.busy)}
                                  onPress={() => handleTestTask(task.id)}
                                />
                                {state?.testResult && (
                                  <span
                                    className="text-xs"
                                    style={{ color: state.testResult.ok ? 'var(--success)' : 'var(--danger)' }}
                                  >
                                    {state.testResult.ok ? 'OK' : state.testResult.message}
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
            )}
          </section>

          <section className="mb-8">
            <h2 className="mb-2 text-sm font-semibold">
              Conexiones ({clientTransports.length + clientDbConnections.length})
            </h2>
            {clientTransports.length + clientDbConnections.length > 0 ? (
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
                    {[
                      ...clientTransports.map((t) => ({ id: t.id, name: t.name, type: t.type.toUpperCase(), host: `${t.host}:${t.port}`, isActive: t.isActive, kind: 'transport' as const })),
                      ...clientDbConnections.map((d) => ({ id: d.id, name: d.name, type: d.engine, host: `${d.host}:${d.port}`, isActive: d.isActive, kind: 'database' as const })),
                    ].map((row) => {
                      const state = actionState[row.id];
                      return (
                        <tr key={row.id} style={{ borderTop: '1px solid var(--separator)', opacity: row.isActive ? 1 : 0.55 }}>
                          <td className="px-4 py-2.5 font-medium">{row.name}</td>
                          <td className="px-4 py-2.5" style={{ color: 'var(--muted)' }}>
                            {row.type}
                          </td>
                          <td className="px-4 py-2.5" style={{ color: 'var(--muted)' }}>
                            {row.host}
                          </td>
                          <td className="px-4 py-2.5">
                            {row.isActive && (
                              <div className="flex items-center gap-2">
                                <IconButton
                                  icon={<PulseIcon />}
                                  label="Probar conexión"
                                  disabled={Boolean(state?.busy)}
                                  onPress={() => handleTestConnection(row.id, row.kind)}
                                />
                                {state?.testResult && (
                                  <span
                                    className="text-xs"
                                    style={{ color: state.testResult.ok ? 'var(--success)' : 'var(--danger)' }}
                                  >
                                    {state.testResult.ok ? 'OK' : state.testResult.message}
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
            )}
          </section>

          <section>
            <h2 className="mb-2 text-sm font-semibold">Historial reciente</h2>
            {runs && runs.length > 0 ? (
              <div className="overflow-x-auto rounded-xl border" style={{ borderColor: 'var(--border)' }}>
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="text-left" style={{ color: 'var(--muted)' }}>
                      <th className="px-4 py-2 font-medium">Tarea</th>
                      <th className="px-4 py-2 font-medium">Estado</th>
                      <th className="px-4 py-2 font-medium">Inicio</th>
                      <th className="px-4 py-2 font-medium">Duración</th>
                      <th className="px-4 py-2 font-medium">Tamaño</th>
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
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm" style={{ color: 'var(--muted)' }}>
                Todavía no hay ejecuciones registradas para este cliente.
              </p>
            )}
          </section>
        </>
      )}
    </div>
  );
}
