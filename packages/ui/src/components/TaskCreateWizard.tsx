import { useEffect, useState } from 'react';
import { Button } from '@heroui/react';
import type { BackupStrategyKind, BackupSet, DbEngine, ScheduleFrequency, DirectDumpCompatibilityResult } from 'engine-core';
import { createTask, setTaskSchedule } from '../lib/tasksClient';
import { createDatabaseConnection, createTransport, type ConnectionsData } from '../lib/connectionsClient';
import { fetchBackupSets } from '../lib/backupSetsClient';
import { Modal } from './Modal';
import { primaryPillStyle, dangerPillStyle } from '../lib/pillStyles';
import { HelpCircleIcon } from './icons';
import { SshSetupGuide } from './SshSetupGuide';

const STRATEGY_LABEL: Record<BackupStrategyKind, string> = {
  fetch_existing: 'SFTP existente',
  remote_dump: 'SSH remoto',
  direct_dump: 'Conexión directa a BD',
};

type ConnectionMode = 'new' | 'existing';

export interface FormValues {
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
  // "new" mode — sftp/ssh/ftp
  /** Only meaningful when strategy is fetch_existing — remote_dump is always ssh, direct_dump has no transport at all. */
  newTransportType: 'sftp' | 'ftp';
  privateKeyPath: string;
  passphrase: string;
  remotePath: string;
  remoteFilePattern: string;
  remoteCommand: string;
  remoteOutputPathTemplate: string;
  remoteCleanup: boolean;
  // "new" mode — direct_dump, and reused for ftp's password (see newTransportType)
  databaseName: string;
  password: string;
  sslMode: string;
  // task-level (dbEngine doubles as the new connection's engine when strategy is direct_dump)
  dbEngine: DbEngine;
  retentionCount: string;
  retentionDays: string;
  scheduleTime: string;
  scheduleEnabled: boolean;
  scheduleFrequency: ScheduleFrequency;
  /** 0 (Sunday) through 6 (Saturday). */
  scheduleDaysOfWeek: number[];
  /** 1-31, as a string for the number input; '' means unset. */
  scheduleDayOfMonth: string;
  /** Optional — a pure visual/reporting label grouping this task with others. '' means unassigned. */
  backupSetId: string;
}

export const EMPTY_FORM: FormValues = {
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
  newTransportType: 'sftp',
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
  scheduleFrequency: 'daily',
  scheduleDaysOfWeek: [],
  scheduleDayOfMonth: '',
  backupSetId: '',
};

export function defaultPortFor(strategy: BackupStrategyKind, dbEngine: DbEngine): string {
  if (strategy !== 'direct_dump') return '22';
  return dbEngine === 'mysql' || dbEngine === 'mariadb' ? '3306' : '5432';
}

/** Prefills a new task's retention with the selected client's own configured defaults, so the form shows what will actually apply instead of a blank field — still freely overridable per task. */
function retentionDefaultsFor(clientId: string, connections: ConnectionsData): { retentionCount: string; retentionDays: string } {
  const client = connections.clients.find((c) => c.id === clientId);
  return {
    retentionCount: client?.retentionCount != null ? String(client.retentionCount) : '',
    retentionDays: client?.retentionDays != null ? String(client.retentionDays) : '',
  };
}

function isCreateValid(values: FormValues): boolean {
  if (!values.clientId || !values.name.trim()) return false;
  if (!isScheduleValid(values)) return false;

  if (values.connectionMode === 'existing') {
    if (values.strategy === 'direct_dump') return Boolean(values.databaseConnectionId);
    if (!values.transportId) return false;
    if (values.strategy === 'fetch_existing') return Boolean(values.remotePath.trim());
    return Boolean(values.remoteCommand.trim() && values.remoteOutputPathTemplate.trim());
  }

  // "new" connection mode
  if (!values.connectionName.trim() || !values.host.trim() || !values.username.trim()) return false;
  if (values.strategy === 'direct_dump') {
    return Boolean(values.databaseName.trim() && values.port.trim() && values.dbEngine !== 'unknown');
  }
  if (values.strategy === 'fetch_existing' && values.newTransportType === 'ftp') {
    return Boolean(values.remotePath.trim());
  }
  if (!values.privateKeyPath.trim()) return false;
  if (values.strategy === 'fetch_existing') return Boolean(values.remotePath.trim());
  return Boolean(values.remoteCommand.trim() && values.remoteOutputPathTemplate.trim());
}

export const inputStyle: React.CSSProperties = {
  backgroundColor: 'var(--background)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  padding: '6px 10px',
  color: 'var(--foreground)',
  width: '100%',
};

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span style={{ color: 'var(--muted)' }}>{label}</span>
      {children}
    </label>
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
  const [showSshGuide, setShowSshGuide] = useState(false);
  return (
    <>
      {showSshGuide && <SshSetupGuide onClose={() => setShowSshGuide(false)} />}
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
          {values.strategy === 'fetch_existing' && (
            <Field label="Protocolo">
              <SegmentedButtons
                value={values.newTransportType}
                onChange={(newTransportType) => onChange({ newTransportType })}
                options={[
                  { value: 'sftp', label: 'SFTP' },
                  { value: 'ftp', label: 'FTP' },
                ]}
              />
            </Field>
          )}
          {values.strategy === 'fetch_existing' && values.newTransportType === 'ftp' ? (
            <Field label="Contraseña">
              <input
                style={inputStyle}
                type="password"
                placeholder="Dejar en blanco para FTP anónimo"
                value={values.password}
                onChange={(e) => onChange({ password: e.target.value })}
              />
            </Field>
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
            </>
          )}
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
              <button
                type="button"
                className="flex items-center gap-1.5 self-start text-xs"
                style={{ color: 'var(--accent)' }}
                onClick={() => setShowSshGuide(true)}
              >
                <HelpCircleIcon className="h-3.5 w-3.5" />
                ¿Cómo configuro esto? (crear usuario, clave y comando de dump)
              </button>
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
              <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--muted)' }}>
                <input
                  type="checkbox"
                  checked={values.remoteCleanup}
                  onChange={(e) => onChange({ remoteCleanup: e.target.checked })}
                />
                Eliminar el archivo remoto tras una descarga exitosa
              </label>
            </>
          )}
        </>
      )}
    </>
  );
}

const FREQUENCY_LABEL: Record<ScheduleFrequency, string> = {
  daily: 'Diario',
  weekly: 'Semanal',
  monthly: 'Mensual',
};

const WEEKDAY_LABEL: { value: number; label: string }[] = [
  { value: 1, label: 'Lun' },
  { value: 2, label: 'Mar' },
  { value: 3, label: 'Mié' },
  { value: 4, label: 'Jue' },
  { value: 5, label: 'Vie' },
  { value: 6, label: 'Sáb' },
  { value: 0, label: 'Dom' },
];

function toggleDay(days: number[], day: number): number[] {
  return days.includes(day) ? days.filter((d) => d !== day) : [...days, day].sort();
}

export function ScheduleFields({ values, onChange }: { values: FormValues; onChange: (patch: Partial<FormValues>) => void }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Horario">
          <input
            style={inputStyle}
            type="time"
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

      <Field label="Frecuencia">
        <SegmentedButtons
          value={values.scheduleFrequency}
          onChange={(scheduleFrequency) => onChange({ scheduleFrequency })}
          options={(Object.keys(FREQUENCY_LABEL) as ScheduleFrequency[]).map((f) => ({ value: f, label: FREQUENCY_LABEL[f] }))}
        />
      </Field>

      {values.scheduleFrequency === 'weekly' && (
        <Field label="Días de la semana *">
          <div className="flex gap-1">
            {WEEKDAY_LABEL.map((day) => (
              <button
                key={day.value}
                type="button"
                onClick={() => onChange({ scheduleDaysOfWeek: toggleDay(values.scheduleDaysOfWeek, day.value) })}
                className="rounded-full px-2.5 py-1 text-xs font-medium"
                style={{
                  backgroundColor: values.scheduleDaysOfWeek.includes(day.value) ? 'var(--accent)' : 'var(--surface-secondary)',
                  color: values.scheduleDaysOfWeek.includes(day.value) ? 'white' : 'var(--muted)',
                }}
              >
                {day.label}
              </button>
            ))}
          </div>
          {values.scheduleDaysOfWeek.length === 0 && (
            <p className="text-xs" style={{ color: 'var(--danger)' }}>
              Elegí al menos un día.
            </p>
          )}
        </Field>
      )}

      {values.scheduleFrequency === 'monthly' && (
        <Field label="Día del mes *">
          <input
            style={inputStyle}
            type="number"
            min={1}
            max={31}
            placeholder="Ej: 15"
            value={values.scheduleDayOfMonth}
            onChange={(e) => onChange({ scheduleDayOfMonth: e.target.value })}
          />
          <p className="text-xs" style={{ color: 'var(--muted)' }}>
            Si el mes tiene menos días, se ejecuta el último día del mes.
          </p>
        </Field>
      )}
    </div>
  );
}

export function isScheduleValid(values: FormValues): boolean {
  if (!values.scheduleTime.trim()) return true;
  if (values.scheduleFrequency === 'weekly') return values.scheduleDaysOfWeek.length > 0;
  if (values.scheduleFrequency === 'monthly') {
    const day = Number(values.scheduleDayOfMonth);
    return Boolean(values.scheduleDayOfMonth.trim()) && Number.isInteger(day) && day >= 1 && day <= 31;
  }
  return true;
}

function CreateFields({
  values,
  onChange,
  connections,
  fixedClientId,
}: {
  values: FormValues;
  onChange: (patch: Partial<FormValues>) => void;
  connections: ConnectionsData;
  fixedClientId?: string;
}) {
  const clientTransports = connections.transports.filter((t) => t.clientId === values.clientId && t.isActive);
  const clientDbConnections = connections.databaseConnections.filter((d) => d.clientId === values.clientId && d.isActive);
  // sftp and ftp are both valid transports for fetch_existing — see the "sftp/ftp are both connect-list-download protocols" note in engine-core's fetchExistingExecutor.ts.
  const fetchExistingTransports = clientTransports.filter((t) => t.type === 'sftp' || t.type === 'ftp');
  const sshTransports = clientTransports.filter((t) => t.type === 'ssh');
  const existingOptions = values.strategy === 'direct_dump' ? clientDbConnections : values.strategy === 'fetch_existing' ? fetchExistingTransports : sshTransports;
  const fixedClientName = fixedClientId ? connections.clients.find((c) => c.id === fixedClientId)?.name : undefined;

  const [backupSets, setBackupSets] = useState<BackupSet[]>([]);
  useEffect(() => {
    if (!values.clientId) {
      setBackupSets([]);
      return;
    }
    fetchBackupSets(values.clientId)
      .then(setBackupSets)
      .catch(() => setBackupSets([]));
  }, [values.clientId]);

  return (
    <div className="flex flex-col gap-3">
      {fixedClientId ? (
        <Field label="Cliente">
          <div style={{ ...inputStyle, color: 'var(--muted)' }}>{fixedClientName ?? fixedClientId}</div>
        </Field>
      ) : (
        <Field label="Cliente *">
          <select
            style={inputStyle}
            value={values.clientId}
            onChange={(e) =>
              onChange({
                clientId: e.target.value,
                transportId: '',
                databaseConnectionId: '',
                ...retentionDefaultsFor(e.target.value, connections),
              })
            }
          >
            <option value="">Seleccionar…</option>
            {connections.clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
      )}

      <Field label="Nombre de la tarea *">
        <input
          style={inputStyle}
          value={values.name}
          onChange={(e) => {
            const name = e.target.value;
            // Keeps the new connection's name in sync with the task's name
            // until the user diverges it on purpose — avoids asking for the
            // same name twice for the common case (a connection created
            // just for this one task).
            const patch: Partial<FormValues> = { name };
            if (values.connectionMode === 'new' && values.connectionName === values.name) {
              patch.connectionName = name;
            }
            onChange(patch);
          }}
        />
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
        <>
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
          {values.strategy === 'fetch_existing' && (
            <Field label="Ruta remota *">
              <input
                style={inputStyle}
                placeholder="Ej: /backups"
                value={values.remotePath}
                onChange={(e) => onChange({ remotePath: e.target.value })}
              />
            </Field>
          )}
          {values.strategy === 'remote_dump' && (
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
              <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--muted)' }}>
                <input
                  type="checkbox"
                  checked={values.remoteCleanup}
                  onChange={(e) => onChange({ remoteCleanup: e.target.checked })}
                />
                Eliminar el archivo remoto tras una descarga exitosa
              </label>
            </>
          )}
        </>
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

      {backupSets.length > 0 && (
        <Field label="Set de backup">
          <select style={inputStyle} value={values.backupSetId} onChange={(e) => onChange({ backupSetId: e.target.value })}>
            <option value="">Sin asignar</option>
            {backupSets.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
      )}

      <ScheduleFields values={values} onChange={onChange} />
    </div>
  );
}

export function TaskCreateWizard({
  connections,
  fixedClientId,
  onClose,
  onCreated,
}: {
  connections: ConnectionsData;
  fixedClientId?: string;
  onClose: () => void;
  onCreated: () => void | Promise<void>;
}) {
  const [form, setForm] = useState<FormValues>(() => ({
    ...EMPTY_FORM,
    clientId: fixedClientId ?? '',
    ...(fixedClientId ? retentionDefaultsFor(fixedClientId, connections) : {}),
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingSchedule, setPendingSchedule] = useState<{ taskId: string; compatibility: DirectDumpCompatibilityResult } | null>(null);

  async function handleCreate() {
    setBusy(true);
    setError(null);
    try {
      let transportId: string | undefined = form.strategy !== 'direct_dump' ? form.transportId || undefined : undefined;
      let databaseConnectionId: string | undefined = form.strategy === 'direct_dump' ? form.databaseConnectionId || undefined : undefined;

      if (form.connectionMode === 'new') {
        if (form.strategy === 'direct_dump') {
          const conn = await createDatabaseConnection({
            clientId: form.clientId,
            name: form.connectionName.trim(),
            engine: form.dbEngine as 'postgres' | 'mysql' | 'mariadb',
            host: form.host.trim(),
            port: Number(form.port),
            databaseName: form.databaseName.trim(),
            username: form.username.trim(),
            password: form.password.trim() || undefined,
          });
          databaseConnectionId = conn.id;
        } else {
          const transportType = form.strategy === 'remote_dump' ? 'ssh' : form.newTransportType;
          const conn = await createTransport({
            type: transportType,
            clientId: form.clientId,
            name: form.connectionName.trim(),
            host: form.host.trim(),
            port: form.port.trim() ? Number(form.port) : undefined,
            username: form.username.trim(),
            privateKeyPath: transportType === 'ftp' ? undefined : form.privateKeyPath.trim(),
            passphrase: transportType === 'ftp' ? undefined : form.passphrase.trim() || undefined,
            password: transportType === 'ftp' ? form.password.trim() || undefined : undefined,
          });
          transportId = conn.id;
        }
      }

      const created = await createTask({
        clientId: form.clientId,
        name: form.name.trim(),
        strategy: form.strategy,
        transportId,
        databaseConnectionId,
        dbEngine: form.dbEngine,
        remotePath: form.strategy === 'fetch_existing' ? form.remotePath.trim() : undefined,
        remoteFilePattern: form.strategy === 'fetch_existing' ? form.remoteFilePattern.trim() || null : undefined,
        remoteCommand: form.strategy === 'remote_dump' ? form.remoteCommand.trim() : undefined,
        remoteOutputPathTemplate: form.strategy === 'remote_dump' ? form.remoteOutputPathTemplate.trim() : undefined,
        remoteCleanup: form.strategy === 'remote_dump' ? form.remoteCleanup : undefined,
        retentionCount: form.retentionCount.trim() ? Number(form.retentionCount) : null,
        retentionDays: form.retentionDays.trim() ? Number(form.retentionDays) : null,
        backupSetId: form.backupSetId || null,
        scheduleTime: form.scheduleTime.trim() || undefined,
        scheduleEnabled: form.scheduleEnabled,
        scheduleFrequency: form.scheduleFrequency,
        scheduleDaysOfWeek: form.scheduleFrequency === 'weekly' ? form.scheduleDaysOfWeek : undefined,
        scheduleDayOfMonth: form.scheduleFrequency === 'monthly' ? Number(form.scheduleDayOfMonth) : undefined,
      });

      if (created.scheduleBlocked) {
        // The task itself was created successfully — only its schedule wasn't applied.
        // Keep the modal open so the user can force it or explicitly leave it unscheduled,
        // but refresh the underlying list now since the task already exists.
        setPendingSchedule({ taskId: created.id, compatibility: created.scheduleBlocked });
        await onCreated();
        return;
      }

      onClose();
      await onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleForceSchedule() {
    if (!pendingSchedule) return;
    setBusy(true);
    setError(null);
    try {
      await setTaskSchedule(pendingSchedule.taskId, {
        scheduleTime: form.scheduleTime.trim() || null,
        scheduleEnabled: form.scheduleEnabled,
        scheduleFrequency: form.scheduleFrequency,
        scheduleDaysOfWeek: form.scheduleFrequency === 'weekly' ? form.scheduleDaysOfWeek : undefined,
        scheduleDayOfMonth: form.scheduleFrequency === 'monthly' ? Number(form.scheduleDayOfMonth) : undefined,
        force: true,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (pendingSchedule) {
    return (
      <Modal title="Agregar backup" onClose={onClose}>
        <p className="text-sm">
          La tarea <strong>{form.name.trim()}</strong> se creó correctamente, pero el horario automático no pudo activarse.
        </p>
        <div className="mt-2 rounded-lg p-3 text-xs" style={{ border: '1px solid var(--danger)', background: 'color-mix(in srgb, var(--danger) 10%, transparent)' }}>
          <p style={{ color: 'var(--danger)' }}>{pendingSchedule.compatibility.message}</p>
          <p className="mt-1" style={{ color: 'var(--muted)' }}>
            Esto no bloquea "Ejecutar ahora" — sólo la activación automática por horario.
          </p>
        </div>
        {error && (
          <p className="mt-2 text-xs" style={{ color: 'var(--danger)' }}>
            {error}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button size="sm" variant="ghost" className="rounded-full px-4" isDisabled={busy} onPress={onClose}>
            Continuar sin horario
          </Button>
          <Button size="sm" className="rounded-full px-4" style={dangerPillStyle} isDisabled={busy} onPress={handleForceSchedule}>
            {busy ? 'Activando…' : 'Forzar y activar horario'}
          </Button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Agregar backup" onClose={onClose}>
      <CreateFields
        values={form}
        onChange={(patch) => setForm((prev) => ({ ...prev, ...patch }))}
        connections={connections}
        fixedClientId={fixedClientId}
      />
      {error && (
        <p className="mt-2 text-xs" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <Button size="sm" variant="ghost" className="rounded-full px-4" isDisabled={busy} onPress={onClose}>
          Cancelar
        </Button>
        <Button size="sm" className="rounded-full px-4" style={primaryPillStyle} isDisabled={busy || !isCreateValid(form)} onPress={handleCreate}>
          {busy ? 'Creando…' : 'Crear'}
        </Button>
      </div>
    </Modal>
  );
}
