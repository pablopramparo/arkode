import { Fragment, useCallback, useEffect, useState } from 'react';
import { Button } from '@heroui/react';
import {
  deactivateDatabaseConnection,
  deactivateTransport,
  fetchConnections,
  reactivateDatabaseConnection,
  reactivateTransport,
  testDatabaseConnection,
  testTransport,
  type ConnectionsData,
  type DatabaseConnectionWithClientName,
  type TransportWithClientName,
} from '../lib/connectionsClient';
import type { ConnectionTestResult } from 'engine-core';
import { Switch } from './Switch';
import { IconButton } from './IconButton';
import { EditIcon, PulseIcon, HelpCircleIcon } from './icons';
import { ConnectionEditModal } from './ConnectionEditModal';
import { ConnectionCreateModal } from './ConnectionCreateModal';
import { SshSetupGuide } from './SshSetupGuide';
import { ClientLink } from './ClientLink';
import { formatConnectionTestVersions } from '../lib/format';
import { primaryPillStyle, dangerPillStyle } from '../lib/pillStyles';

type Kind = 'transport' | 'database';
type TransportType = 'sftp' | 'ssh' | 'ftp';
type Engine = 'postgres' | 'mysql' | 'mariadb';

export type ConnectionRow =
  | { kind: 'transport'; id: string; data: TransportWithClientName }
  | { kind: 'database'; id: string; data: DatabaseConnectionWithClientName };

export interface FormValues {
  kind: Kind;
  transportType: TransportType;
  engine: Engine;
  clientId: string;
  name: string;
  host: string;
  port: string;
  username: string;
  privateKeyPath: string;
  passphrase: string;
  remotePath: string;
  remoteFilePattern: string;
  remoteCommand: string;
  remoteOutputPathTemplate: string;
  remoteCleanup: boolean;
  databaseName: string;
  password: string;
  sslMode: string;
}

function defaultPort(kind: Kind, engine: Engine, transportType: TransportType = 'sftp'): string {
  if (kind === 'transport') return transportType === 'ftp' ? '21' : '22';
  return engine === 'postgres' ? '5432' : '3306';
}

export const EMPTY_FORM: FormValues = {
  kind: 'transport',
  transportType: 'sftp',
  engine: 'postgres',
  clientId: '',
  name: '',
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
};

export function transportToFormValues(t: TransportWithClientName): FormValues {
  return {
    ...EMPTY_FORM,
    kind: 'transport',
    transportType: t.type,
    clientId: t.clientId,
    name: t.name,
    host: t.host,
    port: String(t.port),
    username: t.username,
    privateKeyPath: t.privateKeyPath ?? '',
    remotePath: t.remotePath ?? '',
    remoteFilePattern: t.remoteFilePattern ?? '',
    remoteCommand: t.remoteCommand ?? '',
    remoteOutputPathTemplate: t.remoteOutputPathTemplate ?? '',
    remoteCleanup: t.remoteCleanup,
  };
}

export function databaseToFormValues(d: DatabaseConnectionWithClientName): FormValues {
  return {
    ...EMPTY_FORM,
    kind: 'database',
    engine: d.engine,
    clientId: d.clientId,
    name: d.name,
    host: d.host,
    port: String(d.port),
    username: d.username,
    databaseName: d.databaseName,
    sslMode: d.sslMode ?? '',
  };
}

export function toTransportInput(values: FormValues) {
  const usesRemotePath = values.transportType === 'sftp' || values.transportType === 'ftp';
  return {
    type: values.transportType,
    clientId: values.clientId,
    name: values.name.trim(),
    host: values.host.trim(),
    port: values.port.trim() ? Number(values.port) : undefined,
    username: values.username.trim(),
    privateKeyPath: values.transportType === 'ftp' ? undefined : values.privateKeyPath.trim(),
    passphrase: values.transportType === 'ftp' ? undefined : values.passphrase.trim() || undefined,
    password: values.transportType === 'ftp' ? values.password.trim() || undefined : undefined,
    remotePath: usesRemotePath ? values.remotePath.trim() : undefined,
    remoteFilePattern: usesRemotePath ? values.remoteFilePattern.trim() || null : undefined,
    remoteCommand: values.transportType === 'ssh' ? values.remoteCommand.trim() : undefined,
    remoteOutputPathTemplate: values.transportType === 'ssh' ? values.remoteOutputPathTemplate.trim() : undefined,
    remoteCleanup: values.transportType === 'ssh' ? values.remoteCleanup : undefined,
  };
}

export function toDatabaseInput(values: FormValues) {
  return {
    clientId: values.clientId,
    name: values.name.trim(),
    engine: values.engine,
    host: values.host.trim(),
    port: Number(values.port),
    databaseName: values.databaseName.trim(),
    username: values.username.trim(),
    password: values.password.trim() || undefined,
    sslMode: values.sslMode.trim() || null,
  };
}

export function isFormValid(values: FormValues): boolean {
  if (!values.clientId || !values.name.trim() || !values.host.trim() || !values.username.trim()) return false;
  if (values.kind === 'transport') {
    if (values.transportType === 'ftp') return Boolean(values.remotePath.trim());
    if (!values.privateKeyPath.trim()) return false;
    if (values.transportType === 'sftp') return Boolean(values.remotePath.trim());
    return Boolean(values.remoteCommand.trim() && values.remoteOutputPathTemplate.trim());
  }
  return Boolean(values.databaseName.trim() && values.port.trim());
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

function TypeBadge({ row }: { row: ConnectionRow }) {
  const label = row.kind === 'transport' ? row.data.type.toUpperCase() : row.data.engine;
  return (
    <span
      className="rounded-full px-2 py-0.5 text-xs font-medium"
      style={{ backgroundColor: 'color-mix(in oklab, var(--accent) 15%, transparent)', color: 'var(--accent)' }}
    >
      {label}
    </span>
  );
}

export function ConnectionFields({
  values,
  onChange,
  clients,
  isCreate,
  fixedClientId,
}: {
  values: FormValues;
  onChange: (patch: Partial<FormValues>) => void;
  clients: { id: string; name: string }[];
  isCreate: boolean;
  /** Pre-fills and locks the client selector — used when creating a connection from within a client's own ficha, where the client is already chosen. */
  fixedClientId?: string;
}) {
  const [showSshGuide, setShowSshGuide] = useState(false);

  function setKindAndType(kind: Kind, transportType: TransportType) {
    onChange({ kind, transportType, port: defaultPort(kind, values.engine, transportType) });
  }

  return (
    <div className="flex flex-col gap-3">
      {showSshGuide && <SshSetupGuide onClose={() => setShowSshGuide(false)} />}
      {isCreate && (
        <Field label="Tipo *">
          <div className="flex gap-2">
            {(
              [
                { label: 'SFTP', onClick: () => setKindAndType('transport', 'sftp'), active: values.kind === 'transport' && values.transportType === 'sftp' },
                { label: 'SSH', onClick: () => setKindAndType('transport', 'ssh'), active: values.kind === 'transport' && values.transportType === 'ssh' },
                { label: 'FTP', onClick: () => setKindAndType('transport', 'ftp'), active: values.kind === 'transport' && values.transportType === 'ftp' },
                { label: 'Base de datos', onClick: () => onChange({ kind: 'database', port: defaultPort('database', values.engine) }), active: values.kind === 'database' },
              ] as const
            ).map((opt) => (
              <button
                key={opt.label}
                type="button"
                onClick={opt.onClick}
                className="rounded-full px-3 py-1 text-xs font-medium"
                style={{
                  backgroundColor: opt.active ? 'var(--accent)' : 'var(--surface-secondary)',
                  color: opt.active ? 'white' : 'var(--muted)',
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </Field>
      )}

      <Field label="Cliente *">
        <select
          style={inputStyle}
          value={values.clientId}
          disabled={!isCreate || Boolean(fixedClientId)}
          onChange={(e) => onChange({ clientId: e.target.value })}
        >
          <option value="">Seleccionar…</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Nombre *">
        <input style={inputStyle} value={values.name} onChange={(e) => onChange({ name: e.target.value })} />
      </Field>

      {values.kind === 'database' && isCreate && (
        <Field label="Motor *">
          <select
            style={inputStyle}
            value={values.engine}
            onChange={(e) => {
              const engine = e.target.value as Engine;
              onChange({ engine, port: defaultPort('database', engine) });
            }}
          >
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

      {values.kind === 'transport' ? (
        <>
          {values.transportType === 'ftp' ? (
            <Field label={isCreate ? 'Contraseña' : 'Contraseña (dejar en blanco para no cambiar)'}>
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
              <Field label={isCreate ? 'Passphrase' : 'Passphrase (dejar en blanco para no cambiar)'}>
                <input
                  style={inputStyle}
                  type="password"
                  value={values.passphrase}
                  onChange={(e) => onChange({ passphrase: e.target.value })}
                />
              </Field>
            </>
          )}
          {values.transportType === 'sftp' || values.transportType === 'ftp' ? (
            <>
              <Field label="Ruta remota *">
                <input
                  style={inputStyle}
                  placeholder="Ej: /backups"
                  value={values.remotePath}
                  onChange={(e) => onChange({ remotePath: e.target.value })}
                />
              </Field>
              <Field label="Patrón de archivo remoto">
                <input
                  style={inputStyle}
                  placeholder="Ej: .*\.dump"
                  value={values.remoteFilePattern}
                  onChange={(e) => onChange({ remoteFilePattern: e.target.value })}
                />
              </Field>
            </>
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
      ) : (
        <>
          <Field label="Nombre de base de datos *">
            <input
              style={inputStyle}
              value={values.databaseName}
              onChange={(e) => onChange({ databaseName: e.target.value })}
            />
          </Field>
          <Field label={isCreate ? 'Contraseña' : 'Contraseña (dejar en blanco para no cambiar)'}>
            <input
              style={inputStyle}
              type="password"
              value={values.password}
              onChange={(e) => onChange({ password: e.target.value })}
            />
          </Field>
          <Field label="SSL">
            <select style={inputStyle} value={values.sslMode} onChange={(e) => onChange({ sslMode: e.target.value })}>
              <option value="">Sin especificar</option>
              <option value="disable">Deshabilitado</option>
              <option value="require">Requerido</option>
              <option value="verify-full">Verificación completa</option>
            </select>
          </Field>
        </>
      )}
    </div>
  );
}

interface RowActionState {
  busy?: 'test' | 'toggle';
  testResult?: ConnectionTestResult;
  actionError?: string;
}

export function Conexiones({ onSelectClient }: { onSelectClient: (clientId: string) => void }) {
  const [data, setData] = useState<ConnectionsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [actionState, setActionState] = useState<Record<string, RowActionState>>({});

  const [showCreate, setShowCreate] = useState(false);
  const [editingRow, setEditingRow] = useState<ConnectionRow | null>(null);

  const refresh = useCallback(async (includeInactive: boolean) => {
    try {
      const result = await fetchConnections({ includeInactive });
      setData(result);
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

  async function handleToggleActive(row: ConnectionRow) {
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
      await refresh(showInactive);
    } catch (err) {
      patchAction(row.id, { busy: undefined, actionError: err instanceof Error ? err.message : String(err) });
    }
  }

  async function handleTest(row: ConnectionRow, trustHost?: boolean) {
    patchAction(row.id, { busy: 'test', actionError: undefined, testResult: undefined });
    try {
      const result =
        row.kind === 'transport' ? await testTransport(row.id, trustHost) : await testDatabaseConnection(row.id);
      patchAction(row.id, { busy: undefined, testResult: result });
    } catch (err) {
      patchAction(row.id, { busy: undefined, actionError: err instanceof Error ? err.message : String(err) });
    }
  }

  const rows: ConnectionRow[] = data
    ? [
        ...data.transports.map((t): ConnectionRow => ({ kind: 'transport', id: t.id, data: t })),
        ...data.databaseConnections.map((d): ConnectionRow => ({ kind: 'database', id: d.id, data: d })),
      ].sort((a, b) => a.data.clientName.localeCompare(b.data.clientName) || a.data.name.localeCompare(b.data.name))
    : [];

  return (
    <div className="max-w-[1600px] px-10 py-8">
      <header className="mb-6 flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Conexiones</h1>
          <p className="text-sm" style={{ color: 'var(--muted)' }}>
            {data == null ? 'Cargando…' : `${rows.length} conexión${rows.length === 1 ? '' : 'es'}`}
          </p>
        </div>
        <div className="flex items-center gap-4">
          <Switch checked={showInactive} onChange={() => setShowInactive((v) => !v)} label="Mostrar inactivas" />
          <Button
            size="sm"
            className="rounded-full px-4"
            style={primaryPillStyle}
            onPress={() => setShowCreate(true)}
          >
            + Nueva conexión
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

      {rows.length > 0 && (
        <div className="overflow-x-auto rounded-xl border" style={{ borderColor: 'var(--border)' }}>
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="text-left" style={{ color: 'var(--muted)' }}>
                <th className="px-4 py-2 font-medium">Cliente</th>
                <th className="px-4 py-2 font-medium">Nombre</th>
                <th className="px-4 py-2 font-medium">Tipo</th>
                <th className="px-4 py-2 font-medium">Host</th>
                <th className="px-4 py-2 font-medium">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const state = actionState[row.id];
                const hasDetail = Boolean(state?.testResult || state?.actionError);
                return (
                  <Fragment key={row.id}>
                    <tr style={{ borderTop: '1px solid var(--separator)', opacity: row.data.isActive ? 1 : 0.55 }}>
                      <td className="px-4 py-2.5 font-medium">
                        <ClientLink clientId={row.data.clientId} name={row.data.clientName} onSelect={onSelectClient} />
                      </td>
                      <td className="px-4 py-2.5">
                        {row.data.name}
                        {!row.data.isActive && (
                          <span className="ml-2 text-xs font-normal" style={{ color: 'var(--muted)' }}>
                            (inactiva)
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        <TypeBadge row={row} />
                      </td>
                      <td className="px-4 py-2.5" style={{ color: 'var(--muted)' }}>
                        {row.data.host}:{row.data.port}
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          {row.data.isActive && (
                            <IconButton icon={<EditIcon />} label="Editar" onPress={() => setEditingRow(row)} />
                          )}
                          <IconButton
                            icon={<PulseIcon />}
                            label={state?.busy === 'test' ? 'Probando conexión…' : 'Probar conexión'}
                            disabled={Boolean(state?.busy)}
                            onPress={() => handleTest(row)}
                          />
                          <Button
                            size="sm"
                            className="rounded-full px-3"
                            style={row.data.isActive ? dangerPillStyle : primaryPillStyle}
                            isDisabled={Boolean(state?.busy)}
                            onPress={() => handleToggleActive(row)}
                          >
                            {state?.busy === 'toggle' ? '…' : row.data.isActive ? 'Desactivar' : 'Reactivar'}
                          </Button>
                        </div>
                      </td>
                    </tr>
                    {hasDetail && (
                      <tr style={{ backgroundColor: 'color-mix(in oklab, var(--muted) 8%, transparent)' }}>
                        <td colSpan={5} className="px-4 py-2 text-xs">
                          {state?.actionError && <span style={{ color: 'var(--danger)' }}>Error: {state.actionError}</span>}
                          {state?.testResult && !state.testResult.unknownHost && (
                            <span style={{ color: state.testResult.ok ? 'var(--success)' : 'var(--danger)' }}>
                              {state.testResult.ok ? 'Conexión OK' : 'Conexión fallida'}
                              {state.testResult.message ? ` — ${state.testResult.message}` : ''}
                              {state.testResult.latencyMs != null ? ` (${state.testResult.latencyMs} ms)` : ''}
                              {formatConnectionTestVersions(state.testResult)}
                            </span>
                          )}
                          {state?.testResult?.unknownHost && (
                            <div
                              className="flex flex-wrap items-center gap-2"
                              style={{ color: state.testResult.unknownHost.previousFingerprintSha256 ? 'var(--danger)' : 'var(--warning)' }}
                            >
                              <span>
                                {state.testResult.unknownHost.previousFingerprintSha256 ? (
                                  <>
                                    ⚠ La clave del host cambió desde la última vez ({state.testResult.unknownHost.keyType},
                                    ahora {state.testResult.unknownHost.fingerprintSha256}, antes{' '}
                                    {state.testResult.unknownHost.previousFingerprintSha256}). Esto puede ser normal (el
                                    servidor fue reinstalado) o indicar un problema de seguridad — confirmá con quien
                                    administra el servidor antes de confiar.
                                  </>
                                ) : (
                                  <>
                                    Host desconocido — {state.testResult.unknownHost.keyType}{' '}
                                    {state.testResult.unknownHost.fingerprintSha256}. ¿Confiás en este host?
                                  </>
                                )}
                              </span>
                              <Button
                                size="sm"
                                className="rounded-full px-3"
                                style={primaryPillStyle}
                                isDisabled={state.busy === 'test'}
                                onPress={() => handleTest(row, true)}
                              >
                                Confiar y probar de nuevo
                              </Button>
                            </div>
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

      {data && rows.length === 0 && <p style={{ color: 'var(--muted)' }}>No hay conexiones configuradas todavía.</p>}

      {showCreate && data && (
        <ConnectionCreateModal clients={data.clients} onClose={() => setShowCreate(false)} onCreated={() => refresh(showInactive)} />
      )}

      {editingRow && data && (
        <ConnectionEditModal
          row={editingRow}
          clients={data.clients}
          onClose={() => setEditingRow(null)}
          onSaved={() => refresh(showInactive)}
        />
      )}
    </div>
  );
}
