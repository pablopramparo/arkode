import { Fragment, useCallback, useEffect, useState } from 'react';
import { Button } from '@heroui/react';
import type { BackupStrategyKind, ConnectionTestResult, DbEngine } from 'engine-core';
import {
  createTask,
  deactivateTask,
  fetchTasks,
  reactivateTask,
  setTaskSchedule,
  updateTask,
  type TaskRow,
} from '../lib/tasksClient';
import { fetchConnections, type ConnectionsData } from '../lib/connectionsClient';
import { runTaskNow, testTaskConnection } from '../lib/statusClient';
import { Modal } from './Modal';
import { Switch } from './Switch';
import { primaryPillStyle, dangerPillStyle } from '../lib/pillStyles';

const STRATEGY_LABEL: Record<BackupStrategyKind, string> = {
  fetch_existing: 'SFTP existente',
  remote_dump: 'SSH remoto',
  direct_dump: 'Conexión directa a BD',
};

interface FormValues {
  clientId: string;
  name: string;
  strategy: BackupStrategyKind;
  transportId: string;
  databaseConnectionId: string;
  dbEngine: DbEngine;
  retentionCount: string;
  retentionDays: string;
  scheduleTime: string;
  scheduleEnabled: boolean;
}

const EMPTY_FORM: FormValues = {
  clientId: '',
  name: '',
  strategy: 'fetch_existing',
  transportId: '',
  databaseConnectionId: '',
  dbEngine: 'unknown',
  retentionCount: '',
  retentionDays: '',
  scheduleTime: '',
  scheduleEnabled: true,
};

function taskToFormValues(task: TaskRow): FormValues {
  return {
    ...EMPTY_FORM,
    clientId: task.clientId,
    name: task.name,
    strategy: task.strategy,
    transportId: task.transportId ?? '',
    databaseConnectionId: task.databaseConnectionId ?? '',
    dbEngine: task.dbEngine,
    retentionCount: task.retentionCount != null ? String(task.retentionCount) : '',
    retentionDays: task.retentionDays != null ? String(task.retentionDays) : '',
    scheduleTime: task.scheduleTime ?? '',
    scheduleEnabled: task.scheduleEnabled,
  };
}

function toCreateInput(values: FormValues) {
  return {
    clientId: values.clientId,
    name: values.name.trim(),
    strategy: values.strategy,
    transportId: values.strategy !== 'direct_dump' ? values.transportId : undefined,
    databaseConnectionId: values.strategy === 'direct_dump' ? values.databaseConnectionId : undefined,
    dbEngine: values.dbEngine,
    retentionCount: values.retentionCount.trim() ? Number(values.retentionCount) : null,
    retentionDays: values.retentionDays.trim() ? Number(values.retentionDays) : null,
    scheduleTime: values.scheduleTime.trim() || undefined,
    scheduleEnabled: values.scheduleEnabled,
  };
}

function isCreateValid(values: FormValues): boolean {
  if (!values.clientId || !values.name.trim()) return false;
  if (values.strategy === 'direct_dump') return Boolean(values.databaseConnectionId);
  return Boolean(values.transportId);
}

const inputStyle: React.CSSProperties = {
  backgroundColor: 'var(--background)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  padding: '6px 10px',
  color: 'var(--foreground)',
  width: '100%',
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span style={{ color: 'var(--muted)' }}>{label}</span>
      {children}
    </label>
  );
}

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

function CreateFields({
  values,
  onChange,
  connections,
}: {
  values: FormValues;
  onChange: (patch: Partial<FormValues>) => void;
  connections: ConnectionsData;
}) {
  const clientTransports = connections.transports.filter((t) => t.clientId === values.clientId && t.isActive);
  const clientDbConnections = connections.databaseConnections.filter((d) => d.clientId === values.clientId && d.isActive);
  const sftpTransports = clientTransports.filter((t) => t.type === 'sftp');
  const sshTransports = clientTransports.filter((t) => t.type === 'ssh');

  return (
    <div className="flex flex-col gap-3">
      <Field label="Cliente *">
        <select
          style={inputStyle}
          value={values.clientId}
          onChange={(e) => onChange({ clientId: e.target.value, transportId: '', databaseConnectionId: '' })}
        >
          <option value="">Seleccionar…</option>
          {connections.clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Nombre *">
        <input style={inputStyle} value={values.name} onChange={(e) => onChange({ name: e.target.value })} />
      </Field>

      <Field label="Estrategia *">
        <div className="flex gap-2">
          {(Object.keys(STRATEGY_LABEL) as BackupStrategyKind[]).map((strategy) => (
            <button
              key={strategy}
              type="button"
              onClick={() => onChange({ strategy, transportId: '', databaseConnectionId: '' })}
              className="rounded-full px-3 py-1 text-xs font-medium"
              style={{
                backgroundColor: values.strategy === strategy ? 'var(--accent)' : 'var(--surface-secondary)',
                color: values.strategy === strategy ? 'white' : 'var(--muted)',
              }}
            >
              {STRATEGY_LABEL[strategy]}
            </button>
          ))}
        </div>
      </Field>

      {values.strategy === 'direct_dump' ? (
        <Field label="Conexión de base de datos *">
          <select
            style={inputStyle}
            value={values.databaseConnectionId}
            onChange={(e) => {
              const conn = clientDbConnections.find((d) => d.id === e.target.value);
              onChange({ databaseConnectionId: e.target.value, dbEngine: conn?.engine ?? values.dbEngine });
            }}
          >
            <option value="">Seleccionar…</option>
            {clientDbConnections.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} ({d.engine})
              </option>
            ))}
          </select>
          {values.clientId && clientDbConnections.length === 0 && (
            <p className="text-xs" style={{ color: 'var(--danger)' }}>
              Este cliente no tiene conexiones de base de datos activas. Creá una en Conexiones primero.
            </p>
          )}
        </Field>
      ) : (
        <>
          <Field label="Transporte *">
            <select style={inputStyle} value={values.transportId} onChange={(e) => onChange({ transportId: e.target.value })}>
              <option value="">Seleccionar…</option>
              {(values.strategy === 'fetch_existing' ? sftpTransports : sshTransports).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            {values.clientId && (values.strategy === 'fetch_existing' ? sftpTransports : sshTransports).length === 0 && (
              <p className="text-xs" style={{ color: 'var(--danger)' }}>
                Este cliente no tiene transportes {values.strategy === 'fetch_existing' ? 'SFTP' : 'SSH'} activos. Creá uno en
                Conexiones primero.
              </p>
            )}
          </Field>
          <Field label="Motor de base de datos (para validación)">
            <select style={inputStyle} value={values.dbEngine} onChange={(e) => onChange({ dbEngine: e.target.value as DbEngine })}>
              <option value="unknown">Sin especificar</option>
              <option value="postgres">PostgreSQL</option>
              <option value="mysql">MySQL</option>
              <option value="mariadb">MariaDB</option>
            </select>
          </Field>
        </>
      )}

      <div className="grid grid-cols-2 gap-3">
        <Field label="Retención (N backups)">
          <input
            style={inputStyle}
            type="number"
            min={0}
            placeholder="Usa el default del cliente"
            value={values.retentionCount}
            onChange={(e) => onChange({ retentionCount: e.target.value })}
          />
        </Field>
        <Field label="Retención (N días)">
          <input
            style={inputStyle}
            type="number"
            min={0}
            placeholder="Usa el default del cliente"
            value={values.retentionDays}
            onChange={(e) => onChange({ retentionDays: e.target.value })}
          />
        </Field>
      </div>

      <ScheduleFields values={values} onChange={onChange} />
    </div>
  );
}

function ScheduleFields({ values, onChange }: { values: FormValues; onChange: (patch: Partial<FormValues>) => void }) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <Field label="Horario (HH:MM)">
        <input
          style={inputStyle}
          placeholder="Sin programar"
          value={values.scheduleTime}
          onChange={(e) => onChange({ scheduleTime: e.target.value })}
        />
      </Field>
      <label className="flex items-end gap-2 pb-2 text-sm" style={{ color: 'var(--muted)' }}>
        <input
          type="checkbox"
          checked={values.scheduleEnabled}
          disabled={!values.scheduleTime.trim()}
          onChange={(e) => onChange({ scheduleEnabled: e.target.checked })}
        />
        Programación habilitada
      </label>
    </div>
  );
}

function EditFields({ values, onChange }: { values: FormValues; onChange: (patch: Partial<FormValues>) => void }) {
  return (
    <div className="flex flex-col gap-3">
      <Field label="Nombre *">
        <input style={inputStyle} value={values.name} onChange={(e) => onChange({ name: e.target.value })} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Retención (N backups)">
          <input
            style={inputStyle}
            type="number"
            min={0}
            value={values.retentionCount}
            onChange={(e) => onChange({ retentionCount: e.target.value })}
          />
        </Field>
        <Field label="Retención (N días)">
          <input
            style={inputStyle}
            type="number"
            min={0}
            value={values.retentionDays}
            onChange={(e) => onChange({ retentionDays: e.target.value })}
          />
        </Field>
      </div>
      <ScheduleFields values={values} onChange={onChange} />
    </div>
  );
}

interface RowActionState {
  busy?: 'run' | 'test' | 'toggle';
  testResult?: ConnectionTestResult;
  actionError?: string;
}

export function Tareas() {
  const [tasks, setTasks] = useState<TaskRow[] | null>(null);
  const [connections, setConnections] = useState<ConnectionsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [actionState, setActionState] = useState<Record<string, RowActionState>>({});

  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState<FormValues>(EMPTY_FORM);
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [editingTask, setEditingTask] = useState<TaskRow | null>(null);
  const [editForm, setEditForm] = useState<FormValues>(EMPTY_FORM);
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

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

  async function handleCreate() {
    setCreateBusy(true);
    setCreateError(null);
    try {
      await createTask(toCreateInput(createForm));
      setShowCreate(false);
      await refresh(showInactive);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreateBusy(false);
    }
  }

  function startEdit(task: TaskRow) {
    setEditingTask(task);
    setEditForm(taskToFormValues(task));
    setEditError(null);
  }

  async function handleSaveEdit() {
    if (!editingTask) return;
    setEditBusy(true);
    setEditError(null);
    try {
      await updateTask(editingTask.id, {
        name: editForm.name.trim(),
        retentionCount: editForm.retentionCount.trim() ? Number(editForm.retentionCount) : null,
        retentionDays: editForm.retentionDays.trim() ? Number(editForm.retentionDays) : null,
      });
      await setTaskSchedule(editingTask.id, editForm.scheduleTime.trim() || null, editForm.scheduleEnabled);
      setEditingTask(null);
      await refresh(showInactive);
    } catch (err) {
      setEditError(err instanceof Error ? err.message : String(err));
    } finally {
      setEditBusy(false);
    }
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
    patchAction(task.id, { busy: 'test', actionError: undefined, testResult: undefined });
    try {
      const result = await testTaskConnection(task.id);
      patchAction(task.id, { busy: undefined, testResult: result });
    } catch (err) {
      patchAction(task.id, { busy: undefined, actionError: err instanceof Error ? err.message : String(err) });
    }
  }

  return (
    <div className="mx-auto max-w-6xl px-8 py-8">
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
            onPress={() => {
              setCreateForm(EMPTY_FORM);
              setCreateError(null);
              setShowCreate(true);
            }}
          >
            + Nueva tarea
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
                const hasDetail = Boolean(state?.testResult || state?.actionError);
                return (
                  <Fragment key={task.id}>
                    <tr style={{ borderTop: '1px solid var(--separator)', opacity: task.isActive ? 1 : 0.55 }}>
                      <td className="px-4 py-2.5 font-medium">{task.clientName}</td>
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
                        {task.scheduleTime ? `${task.scheduleTime}${task.scheduleEnabled ? '' : ' (deshabilitado)'}` : 'Sin programar'}
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          {task.isActive && (
                            <>
                              <Button size="sm" variant="ghost" className="rounded-full px-3" onPress={() => startEdit(task)}>
                                Editar
                              </Button>
                              <Button
                                size="sm"
                                className="rounded-full px-3"
                                style={primaryPillStyle}
                                isDisabled={Boolean(state?.busy)}
                                onPress={() => handleRun(task)}
                              >
                                {state?.busy === 'run' ? 'Ejecutando…' : 'Ejecutar ahora'}
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="rounded-full px-3"
                                isDisabled={Boolean(state?.busy)}
                                onPress={() => handleTest(task)}
                              >
                                {state?.busy === 'test' ? 'Probando…' : 'Probar conexión'}
                              </Button>
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
        <Modal title="Nueva tarea" onClose={() => setShowCreate(false)}>
          <CreateFields values={createForm} onChange={(patch) => setCreateForm((prev) => ({ ...prev, ...patch }))} connections={connections} />
          {createError && (
            <p className="mt-2 text-xs" style={{ color: 'var(--danger)' }}>
              {createError}
            </p>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <Button size="sm" variant="ghost" className="rounded-full px-4" isDisabled={createBusy} onPress={() => setShowCreate(false)}>
              Cancelar
            </Button>
            <Button
              size="sm"
              className="rounded-full px-4"
              style={primaryPillStyle}
              isDisabled={createBusy || !isCreateValid(createForm)}
              onPress={handleCreate}
            >
              {createBusy ? 'Creando…' : 'Crear'}
            </Button>
          </div>
        </Modal>
      )}

      {editingTask && (
        <Modal title={`Editar "${editingTask.name}"`} onClose={() => setEditingTask(null)}>
          <EditFields values={editForm} onChange={(patch) => setEditForm((prev) => ({ ...prev, ...patch }))} />
          {editError && (
            <p className="mt-2 text-xs" style={{ color: 'var(--danger)' }}>
              {editError}
            </p>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <Button size="sm" variant="ghost" className="rounded-full px-4" isDisabled={editBusy} onPress={() => setEditingTask(null)}>
              Cancelar
            </Button>
            <Button
              size="sm"
              className="rounded-full px-4"
              style={primaryPillStyle}
              isDisabled={editBusy || !editForm.name.trim()}
              onPress={handleSaveEdit}
            >
              {editBusy ? 'Guardando…' : 'Guardar'}
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
