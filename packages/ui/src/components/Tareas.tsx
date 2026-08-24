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
import { createDatabaseConnection, createTransport, fetchConnections, type ConnectionsData } from '../lib/connectionsClient';
import { runTaskNow, testTaskConnection } from '../lib/statusClient';
import { Modal } from './Modal';
import { Switch } from './Switch';
import { IconButton } from './IconButton';
import { PulseIcon } from './icons';
import { primaryPillStyle, dangerPillStyle } from '../lib/pillStyles';

const STRATEGY_LABEL: Record<BackupStrategyKind, string> = {
  fetch_existing: 'SFTP existente',
  remote_dump: 'SSH remoto',
  direct_dump: 'Conexión directa a BD',
};

type ConnectionMode = 'new' | 'existing';

interface FormValues {
  clientId: string;
  name: string;
  strategy: BackupStrategyKind;
  connectionMode: ConnectionMode;
  // "existing" mode
  transportId: string;
  databaseConnectionId: string;
  // "new" mode — shared
  connectionName: string;
  host: string;
  port: string;
  username: string;
  // "new" mode — sftp/ssh
  privateKeyPath: string;
  passphrase: string;
  remotePath: string;
  remoteFilePattern: string;
  remoteCommand: string;
  remoteOutputPathTemplate: string;
  remoteCleanup: boolean;
  // "new" mode — direct_dump
  databaseName: string;
  password: string;
  sslMode: string;
  // task-level (dbEngine doubles as the new connection's engine when strategy is direct_dump)
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
  connectionMode: 'new',
  transportId: '',
  databaseConnectionId: '',
  connectionName: '',
  host: '',
  port: '22',
  username: '',
  privateKeyPath: '',
  passphrase: '',
  remotePath: '',
  remoteFilePattern: '',
  remoteCommand: '',
  remoteOutputPathTemplate: '',
  remoteCleanup: false,
  databaseName: '',
  password: '',
  sslMode: '',
  dbEngine: 'unknown',
  retentionCount: '',
  retentionDays: '',
  scheduleTime: '',
  scheduleEnabled: true,
};

function defaultPortFor(strategy: BackupStrategyKind, dbEngine: DbEngine): string {
  if (strategy !== 'direct_dump') return '22';
  return dbEngine === 'mysql' || dbEngine === 'mariadb' ? '3306' : '5432';
}

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

function isCreateValid(values: FormValues): boolean {
  if (!values.clientId || !values.name.trim()) return false;

  if (values.connectionMode === 'existing') {
    return values.strategy === 'direct_dump' ? Boolean(values.databaseConnectionId) : Boolean(values.transportId);
  }

  // "new" connection mode
  if (!values.connectionName.trim() || !values.host.trim() || !values.username.trim()) return false;
  if (values.strategy === 'direct_dump') {
    return Boolean(values.databaseName.trim() && values.port.trim() && values.dbEngine !== 'unknown');
  }
  if (!values.privateKeyPath.trim()) return false;
  if (values.strategy === 'fetch_existing') return Boolean(values.remotePath.trim());
  return Boolean(values.remoteCommand.trim() && values.remoteOutputPathTemplate.trim());
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

function SegmentedButtons<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex gap-2">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className="rounded-full px-3 py-1 text-xs font-medium"
          style={{
            backgroundColor: value === opt.value ? 'var(--accent)' : 'var(--surface-secondary)',
            color: value === opt.value ? 'white' : 'var(--muted)',
          }}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

/** The connection-specific fields for creating a brand-new transport/database connection inline — deliberately simpler than Conexiones.tsx's own form (no type/client selector; the strategy and client are already chosen one step up in this same wizard). */
function NewConnectionFields({ values, onChange }: { values: FormValues; onChange: (patch: Partial<FormValues>) => void }) {
  return (
    <>
      <Field label="Nombre de la conexión *">
        <input
          style={inputStyle}
          placeholder="Ej: Servidor principal"
          value={values.connectionName}
          onChange={(e) => onChange({ connectionName: e.target.value })}
        />
      </Field>

      {values.strategy === 'direct_dump' && (
        <Field label="Motor *">
          <select
            style={inputStyle}
            value={values.dbEngine === 'unknown' ? '' : values.dbEngine}
            onChange={(e) => {
              const dbEngine = e.target.value as DbEngine;
              onChange({ dbEngine, port: defaultPortFor('direct_dump', dbEngine) });
            }}
          >
            <option value="">Seleccionar…</option>
            <option value="postgres">PostgreSQL</option>
            <option value="mysql">MySQL</option>
            <option value="mariadb">MariaDB</option>
          </select>
        </Field>
      )}

      <div className="grid grid-cols-2 gap-3">
        <Field label="Host *">
          <input style={inputStyle} value={values.host} onChange={(e) => onChange({ host: e.target.value })} />
        </Field>
        <Field label="Puerto">
          <input style={inputStyle} type="number" value={values.port} onChange={(e) => onChange({ port: e.target.value })} />
        </Field>
      </div>

      <Field label="Usuario *">
        <input style={inputStyle} value={values.username} onChange={(e) => onChange({ username: e.target.value })} />
      </Field>

      {values.strategy === 'direct_dump' ? (
        <>
          <Field label="Nombre de base de datos *">
            <input
              style={inputStyle}
              value={values.databaseName}
              onChange={(e) => onChange({ databaseName: e.target.value })}
            />
          </Field>
          <Field label="Contraseña">
            <input
              style={inputStyle}
              type="password"
              value={values.password}
              onChange={(e) => onChange({ password: e.target.value })}
            />
          </Field>
        </>
      ) : (
        <>
          <Field label="Ruta de clave privada *">
            <input
              style={inputStyle}
              placeholder="Ej: C:/keys/id_rsa"
              value={values.privateKeyPath}
              onChange={(e) => onChange({ privateKeyPath: e.target.value })}
            />
          </Field>
          <Field label="Passphrase">
            <input
              style={inputStyle}
              type="password"
              value={values.passphrase}
              onChange={(e) => onChange({ passphrase: e.target.value })}
            />
          </Field>
          {values.strategy === 'fetch_existing' ? (
            <Field label="Ruta remota *">
              <input
                style={inputStyle}
                placeholder="Ej: /backups"
                value={values.remotePath}
                onChange={(e) => onChange({ remotePath: e.target.value })}
              />
            </Field>
          ) : (
            <>
              <Field label="Comando remoto *">
                <input
                  style={inputStyle}
                  placeholder="Comando que genera el dump en el host remoto"
                  value={values.remoteCommand}
                  onChange={(e) => onChange({ remoteCommand: e.target.value })}
                />
              </Field>
              <Field label="Plantilla de ruta de salida *">
                <input
                  style={inputStyle}
                  placeholder="Ej: /tmp/backups/db_{date:YYYYMMDD_HHmm}.dump"
                  value={values.remoteOutputPathTemplate}
                  onChange={(e) => onChange({ remoteOutputPathTemplate: e.target.value })}
                />
              </Field>
            </>
          )}
        </>
      )}
    </>
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
  const existingOptions = values.strategy === 'direct_dump' ? clientDbConnections : values.strategy === 'fetch_existing' ? sftpTransports : sshTransports;

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

      <Field label="Nombre de la tarea *">
        <input style={inputStyle} value={values.name} onChange={(e) => onChange({ name: e.target.value })} />
      </Field>

      <Field label="Estrategia *">
        <SegmentedButtons
          value={values.strategy}
          onChange={(strategy) =>
            onChange({
              strategy,
              transportId: '',
              databaseConnectionId: '',
              port: defaultPortFor(strategy, values.dbEngine),
              dbEngine: strategy === 'direct_dump' ? values.dbEngine : values.dbEngine === 'mariadb' ? 'unknown' : values.dbEngine,
            })
          }
          options={(Object.keys(STRATEGY_LABEL) as BackupStrategyKind[]).map((s) => ({ value: s, label: STRATEGY_LABEL[s] }))}
        />
      </Field>

      <Field label="Conexión">
        <SegmentedButtons
          value={values.connectionMode}
          onChange={(connectionMode) => onChange({ connectionMode })}
          options={[
            { value: 'new', label: '+ Crear conexión nueva' },
            { value: 'existing', label: 'Usar conexión existente' },
          ]}
        />
      </Field>

      {values.connectionMode === 'new' ? (
        <NewConnectionFields values={values} onChange={onChange} />
      ) : (
        <Field label={values.strategy === 'direct_dump' ? 'Conexión de base de datos *' : 'Transporte *'}>
          <select
            style={inputStyle}
            value={values.strategy === 'direct_dump' ? values.databaseConnectionId : values.transportId}
            onChange={(e) =>
              values.strategy === 'direct_dump'
                ? onChange({
                    databaseConnectionId: e.target.value,
                    dbEngine: clientDbConnections.find((d) => d.id === e.target.value)?.engine ?? values.dbEngine,
                  })
                : onChange({ transportId: e.target.value })
            }
          >
            <option value="">Seleccionar…</option>
            {existingOptions.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.name}
              </option>
            ))}
          </select>
          {values.clientId && existingOptions.length === 0 && (
            <p className="text-xs" style={{ color: 'var(--danger)' }}>
              Este cliente no tiene {values.strategy === 'direct_dump' ? 'conexiones de base de datos' : 'transportes de este tipo'}{' '}
              activas — probá "Crear conexión nueva".
            </p>
          )}
        </Field>
      )}

      {values.strategy !== 'direct_dump' && (
        <Field label="Motor de base de datos (para validación)">
          <select style={inputStyle} value={values.dbEngine} onChange={(e) => onChange({ dbEngine: e.target.value as DbEngine })}>
            <option value="unknown">Sin especificar</option>
            <option value="postgres">PostgreSQL</option>
            <option value="mysql">MySQL</option>
          </select>
        </Field>
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
      let transportId: string | undefined = createForm.strategy !== 'direct_dump' ? createForm.transportId || undefined : undefined;
      let databaseConnectionId: string | undefined =
        createForm.strategy === 'direct_dump' ? createForm.databaseConnectionId || undefined : undefined;

      if (createForm.connectionMode === 'new') {
        if (createForm.strategy === 'direct_dump') {
          const conn = await createDatabaseConnection({
            clientId: createForm.clientId,
            name: createForm.connectionName.trim(),
            engine: createForm.dbEngine as 'postgres' | 'mysql' | 'mariadb',
            host: createForm.host.trim(),
            port: Number(createForm.port),
            databaseName: createForm.databaseName.trim(),
            username: createForm.username.trim(),
            password: createForm.password.trim() || undefined,
          });
          databaseConnectionId = conn.id;
        } else {
          const conn = await createTransport({
            type: createForm.strategy === 'remote_dump' ? 'ssh' : 'sftp',
            clientId: createForm.clientId,
            name: createForm.connectionName.trim(),
            host: createForm.host.trim(),
            port: createForm.port.trim() ? Number(createForm.port) : undefined,
            username: createForm.username.trim(),
            privateKeyPath: createForm.privateKeyPath.trim(),
            passphrase: createForm.passphrase.trim() || undefined,
            remotePath: createForm.strategy === 'fetch_existing' ? createForm.remotePath.trim() : undefined,
            remoteCommand: createForm.strategy === 'remote_dump' ? createForm.remoteCommand.trim() : undefined,
            remoteOutputPathTemplate: createForm.strategy === 'remote_dump' ? createForm.remoteOutputPathTemplate.trim() : undefined,
          });
          transportId = conn.id;
        }
      }

      await createTask({
        clientId: createForm.clientId,
        name: createForm.name.trim(),
        strategy: createForm.strategy,
        transportId,
        databaseConnectionId,
        dbEngine: createForm.dbEngine,
        retentionCount: createForm.retentionCount.trim() ? Number(createForm.retentionCount) : null,
        retentionDays: createForm.retentionDays.trim() ? Number(createForm.retentionDays) : null,
        scheduleTime: createForm.scheduleTime.trim() || undefined,
        scheduleEnabled: createForm.scheduleEnabled,
      });

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
            onPress={() => {
              setCreateForm(EMPTY_FORM);
              setCreateError(null);
              setShowCreate(true);
            }}
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
                              <IconButton
                                icon={<PulseIcon />}
                                label={state?.busy === 'test' ? 'Probando conexión…' : 'Probar conexión'}
                                disabled={Boolean(state?.busy)}
                                onPress={() => handleTest(task)}
                              />
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
        <Modal title="Agregar backup" onClose={() => setShowCreate(false)}>
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
