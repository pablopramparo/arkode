import { Fragment, useCallback, useEffect, useState } from 'react';
import { Button } from '@heroui/react';
import type { BackupStrategyKind, ConnectionTestResult, DirectDumpCompatibilityResult } from 'engine-core';
import { deactivateTask, fetchTasks, reactivateTask, type TaskRow } from '../lib/tasksClient';
import { fetchConnections, type ConnectionsData } from '../lib/connectionsClient';
import { runTaskNow, testTaskConnection, testTaskCompatibility } from '../lib/statusClient';
import { Switch } from './Switch';
import { IconButton } from './IconButton';
import { EditIcon, PlayIcon, PulseIcon, CheckCircleIcon } from './icons';
import { primaryPillStyle, dangerPillStyle } from '../lib/pillStyles';
import { formatSchedule, formatConnectionTestVersions } from '../lib/format';
import { TaskCreateWizard } from './TaskCreateWizard';
import { TaskEditModal } from './TaskEditModal';
import { ClientLink } from './ClientLink';

const STRATEGY_LABEL: Record<BackupStrategyKind, string> = {
  fetch_existing: 'SFTP existente',
  remote_dump: 'SSH remoto',
  direct_dump: 'Conexión directa a BD',
};

function StrategyBadge({ strategy }: { strategy: BackupStrategyKind }) {
  return (
    <span
      className="rounded-full px-2 py-0.5 text-xs font-medium"
      style={{ backgroundColor: 'color-mix(in oklab, var(--accent) 15%, transparent)', color: 'var(--accent)' }}
    >
      {STRATEGY_LABEL[strategy]}
    </span>
  );
}

interface RowActionState {
  busy?: 'run' | 'test' | 'compatibility' | 'toggle';
  testResult?: ConnectionTestResult;
  compatibilityResult?: DirectDumpCompatibilityResult;
  actionError?: string;
}

export function Tareas({ onSelectClient }: { onSelectClient: (clientId: string) => void }) {
  const [tasks, setTasks] = useState<TaskRow[] | null>(null);
  const [connections, setConnections] = useState<ConnectionsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [actionState, setActionState] = useState<Record<string, RowActionState>>({});

  const [showCreate, setShowCreate] = useState(false);
  const [editingTask, setEditingTask] = useState<TaskRow | null>(null);

  const refresh = useCallback(async (includeInactive: boolean) => {
    try {
      const [taskRows, connectionsData] = await Promise.all([fetchTasks({ includeInactive }), fetchConnections()]);
      setTasks(taskRows);
      setConnections(connectionsData);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo conectar con el motor de backups.');
    }
  }, []);

  useEffect(() => {
    refresh(showInactive);
  }, [refresh, showInactive]);

  function patchAction(id: string, patch: RowActionState) {
    setActionState((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }

  async function handleToggleActive(task: TaskRow) {
    if (task.isActive && !window.confirm(`¿Desactivar "${task.name}"? Dejará de programarse; su historial no se toca.`)) {
      return;
    }
    patchAction(task.id, { busy: 'toggle', actionError: undefined });
    try {
      await (task.isActive ? deactivateTask(task.id) : reactivateTask(task.id));
      patchAction(task.id, { busy: undefined });
      await refresh(showInactive);
    } catch (err) {
      patchAction(task.id, { busy: undefined, actionError: err instanceof Error ? err.message : String(err) });
    }
  }

  async function handleRun(task: TaskRow) {
    patchAction(task.id, { busy: 'run', actionError: undefined, testResult: undefined });
    try {
      await runTaskNow(task.id);
      patchAction(task.id, { busy: undefined });
    } catch (err) {
      patchAction(task.id, { busy: undefined, actionError: err instanceof Error ? err.message : String(err) });
    }
  }

  async function handleTest(task: TaskRow) {
    patchAction(task.id, { busy: 'test', actionError: undefined, testResult: undefined, compatibilityResult: undefined });
    try {
      const result = await testTaskConnection(task.id);
      patchAction(task.id, { busy: undefined, testResult: result });
    } catch (err) {
      patchAction(task.id, { busy: undefined, actionError: err instanceof Error ? err.message : String(err) });
    }
  }

  async function handleTestCompatibility(task: TaskRow) {
    patchAction(task.id, { busy: 'compatibility', actionError: undefined, testResult: undefined, compatibilityResult: undefined });
    try {
      const result = await testTaskCompatibility(task.id);
      patchAction(task.id, { busy: undefined, compatibilityResult: result });
    } catch (err) {
      patchAction(task.id, { busy: undefined, actionError: err instanceof Error ? err.message : String(err) });
    }
  }

  return (
    <div className="max-w-[1600px] px-10 py-8">
      <header className="mb-6 flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Tareas</h1>
          <p className="text-sm" style={{ color: 'var(--muted)' }}>
            {tasks == null ? 'Cargando…' : `${tasks.length} tarea${tasks.length === 1 ? '' : 's'}`}
          </p>
        </div>
        <div className="flex items-center gap-4">
          <Switch checked={showInactive} onChange={() => setShowInactive((v) => !v)} label="Mostrar inactivas" />
          <Button
            size="sm"
            className="rounded-full px-4"
            style={primaryPillStyle}
            isDisabled={!connections || connections.clients.length === 0}
            onPress={() => setShowCreate(true)}
          >
            + Agregar backup
          </Button>
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

      {tasks && tasks.length > 0 && (
        <div className="overflow-x-auto rounded-xl border" style={{ borderColor: 'var(--border)' }}>
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="text-left" style={{ color: 'var(--muted)' }}>
                <th className="px-4 py-2 font-medium">Cliente</th>
                <th className="px-4 py-2 font-medium">Nombre</th>
                <th className="px-4 py-2 font-medium">Estrategia</th>
                <th className="px-4 py-2 font-medium">Origen</th>
                <th className="px-4 py-2 font-medium">Horario</th>
                <th className="px-4 py-2 font-medium">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => {
                const state = actionState[task.id];
                const hasDetail = Boolean(state?.testResult || state?.compatibilityResult || state?.actionError);
                return (
                  <Fragment key={task.id}>
                    <tr style={{ borderTop: '1px solid var(--separator)', opacity: task.isActive ? 1 : 0.55 }}>
                      <td className="px-4 py-2.5 font-medium">
                        <ClientLink clientId={task.clientId} name={task.clientName} onSelect={onSelectClient} />
                      </td>
                      <td className="px-4 py-2.5">
                        {task.name}
                        {!task.isActive && (
                          <span className="ml-2 text-xs font-normal" style={{ color: 'var(--muted)' }}>
                            (inactiva)
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        <StrategyBadge strategy={task.strategy} />
                      </td>
                      <td className="px-4 py-2.5" style={{ color: 'var(--muted)' }}>
                        {task.transportName ?? task.databaseConnectionName ?? '—'}
                      </td>
                      <td className="px-4 py-2.5" style={{ color: 'var(--muted)' }}>
                        {formatSchedule(task)}
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          {task.isActive && (
                            <>
                              <Button
                                size="sm"
                                className="rounded-full px-3"
                                style={primaryPillStyle}
                                isDisabled={Boolean(state?.busy)}
                                onPress={() => handleRun(task)}
                              >
                                {state?.busy === 'run' ? (
                                  'Ejecutando…'
                                ) : (
                                  <span className="flex items-center gap-1.5">
                                    <PlayIcon className="h-3.5 w-3.5" />
                                    Ejecutar ahora
                                  </span>
                                )}
                              </Button>
                              <IconButton
                                icon={<PulseIcon />}
                                label={state?.busy === 'test' ? 'Probando conexión…' : 'Probar conexión'}
                                disabled={Boolean(state?.busy)}
                                onPress={() => handleTest(task)}
                              />
                              {task.strategy === 'direct_dump' && (
                                <IconButton
                                  icon={<CheckCircleIcon />}
                                  label={state?.busy === 'compatibility' ? 'Probando compatibilidad…' : 'Probar compatibilidad (versión + herramienta)'}
                                  disabled={Boolean(state?.busy)}
                                  onPress={() => handleTestCompatibility(task)}
                                />
                              )}
                              <IconButton icon={<EditIcon />} label="Editar" onPress={() => setEditingTask(task)} />
                            </>
                          )}
                          <Button
                            size="sm"
                            className="rounded-full px-3"
                            style={task.isActive ? dangerPillStyle : primaryPillStyle}
                            isDisabled={state?.busy === 'toggle'}
                            onPress={() => handleToggleActive(task)}
                          >
                            {state?.busy === 'toggle' ? '…' : task.isActive ? 'Desactivar' : 'Reactivar'}
                          </Button>
                        </div>
                      </td>
                    </tr>
                    {hasDetail && (
                      <tr style={{ backgroundColor: 'color-mix(in oklab, var(--muted) 8%, transparent)' }}>
                        <td colSpan={6} className="px-4 py-2 text-xs">
                          {state?.actionError && <span style={{ color: 'var(--danger)' }}>Error: {state.actionError}</span>}
                          {state?.testResult && (
                            <span style={{ color: state.testResult.ok ? 'var(--success)' : 'var(--danger)' }}>
                              {state.testResult.ok ? 'Conexión OK' : 'Conexión fallida'}
                              {state.testResult.message ? ` — ${state.testResult.message}` : ''}
                              {state.testResult.latencyMs != null ? ` (${state.testResult.latencyMs} ms)` : ''}
                              {formatConnectionTestVersions(state.testResult)}
                            </span>
                          )}
                          {state?.compatibilityResult && (
                            <span style={{ color: state.compatibilityResult.ok ? 'var(--success)' : 'var(--danger)' }}>
                              {state.compatibilityResult.ok ? 'Compatible' : 'No compatible'} — {state.compatibilityResult.message}
                              {formatConnectionTestVersions(state.compatibilityResult.connection)}
                            </span>
                          )}
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

      {tasks && tasks.length === 0 && <p style={{ color: 'var(--muted)' }}>No hay tareas configuradas todavía.</p>}

      {showCreate && connections && (
        <TaskCreateWizard
          connections={connections}
          onClose={() => setShowCreate(false)}
          onCreated={() => refresh(showInactive)}
        />
      )}

      {editingTask && (
        <TaskEditModal task={editingTask} onClose={() => setEditingTask(null)} onSaved={() => refresh(showInactive)} />
      )}
    </div>
  );
}
