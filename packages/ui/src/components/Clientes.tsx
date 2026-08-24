import { useCallback, useEffect, useState } from 'react';
import { Button } from '@heroui/react';
import {
  createClient,
  deactivateClient,
  fetchClients,
  reactivateClient,
  updateClient,
  type ClientWithTaskCount,
} from '../lib/clientsClient';
import { formatRetention } from '../lib/format';
import { Modal } from './Modal';
import { Switch } from './Switch';
import { primaryPillStyle, dangerPillStyle } from '../lib/pillStyles';

interface ClientFormValues {
  name: string;
  description: string;
  localBasePath: string;
  retentionCount: string;
  retentionDays: string;
}

const EMPTY_FORM: ClientFormValues = { name: '', description: '', localBasePath: '', retentionCount: '', retentionDays: '' };

function toClientFormValues(client: ClientWithTaskCount): ClientFormValues {
  return {
    name: client.name,
    description: client.description ?? '',
    localBasePath: client.localBasePath,
    retentionCount: client.retentionCount != null ? String(client.retentionCount) : '',
    retentionDays: client.retentionDays != null ? String(client.retentionDays) : '',
  };
}

function toInput(values: ClientFormValues) {
  return {
    name: values.name.trim(),
    description: values.description.trim() ? values.description.trim() : null,
    localBasePath: values.localBasePath.trim(),
    retentionCount: values.retentionCount.trim() ? Number(values.retentionCount) : null,
    retentionDays: values.retentionDays.trim() ? Number(values.retentionDays) : null,
  };
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

function ClientFields({
  values,
  onChange,
}: {
  values: ClientFormValues;
  onChange: (patch: Partial<ClientFormValues>) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <Field label="Nombre *">
        <input style={inputStyle} value={values.name} onChange={(e) => onChange({ name: e.target.value })} autoFocus />
      </Field>
      <Field label="Descripción">
        <textarea
          style={{ ...inputStyle, minHeight: 64, resize: 'vertical' }}
          value={values.description}
          onChange={(e) => onChange({ description: e.target.value })}
        />
      </Field>
      <Field label="Carpeta local *">
        <input
          style={inputStyle}
          placeholder="Ej: D:/Backups/Cliente"
          value={values.localBasePath}
          onChange={(e) => onChange({ localBasePath: e.target.value })}
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Retención (N backups)">
          <input
            style={inputStyle}
            type="number"
            min={0}
            placeholder="Ej: 10"
            value={values.retentionCount}
            onChange={(e) => onChange({ retentionCount: e.target.value })}
          />
        </Field>
        <Field label="Retención (N días)">
          <input
            style={inputStyle}
            type="number"
            min={0}
            placeholder="Ej: 30"
            value={values.retentionDays}
            onChange={(e) => onChange({ retentionDays: e.target.value })}
          />
        </Field>
      </div>
    </div>
  );
}

export function Clientes() {
  const [clients, setClients] = useState<ClientWithTaskCount[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);

  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState<ClientFormValues>(EMPTY_FORM);
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [editingClient, setEditingClient] = useState<ClientWithTaskCount | null>(null);
  const [editForm, setEditForm] = useState<ClientFormValues>(EMPTY_FORM);
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const [deactivatingId, setDeactivatingId] = useState<string | null>(null);
  const [reactivatingId, setReactivatingId] = useState<string | null>(null);

  const refresh = useCallback(async (includeInactive: boolean) => {
    try {
      const data = await fetchClients({ includeInactive });
      setClients(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo conectar con el motor de backups.');
    }
  }, []);

  useEffect(() => {
    refresh(showInactive);
  }, [refresh, showInactive]);

  async function handleCreate() {
    setCreateBusy(true);
    setCreateError(null);
    try {
      await createClient(toInput(createForm));
      setShowCreate(false);
      setCreateForm(EMPTY_FORM);
      await refresh(showInactive);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreateBusy(false);
    }
  }

  function startEdit(client: ClientWithTaskCount) {
    setEditingClient(client);
    setEditForm(toClientFormValues(client));
    setEditError(null);
  }

  async function handleSaveEdit() {
    if (!editingClient) return;
    setEditBusy(true);
    setEditError(null);
    try {
      await updateClient(editingClient.id, toInput(editForm));
      setEditingClient(null);
      await refresh(showInactive);
    } catch (err) {
      setEditError(err instanceof Error ? err.message : String(err));
    } finally {
      setEditBusy(false);
    }
  }

  async function handleDeactivate(client: ClientWithTaskCount) {
    if (!window.confirm(`¿Desactivar "${client.name}"? Sus tareas dejarán de aparecer en el dashboard y de programarse.`)) {
      return;
    }
    setDeactivatingId(client.id);
    try {
      await deactivateClient(client.id);
      await refresh(showInactive);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeactivatingId(null);
    }
  }

  async function handleReactivate(client: ClientWithTaskCount) {
    setReactivatingId(client.id);
    try {
      await reactivateClient(client.id);
      await refresh(showInactive);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setReactivatingId(null);
    }
  }

  return (
    <div className="mx-auto max-w-6xl px-8 py-8">
      <header className="mb-6 flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Clientes</h1>
          <p className="text-sm" style={{ color: 'var(--muted)' }}>
            {clients == null
              ? 'Cargando…'
              : showInactive
                ? `${clients.filter((c) => c.isActive).length} activo(s), ${clients.filter((c) => !c.isActive).length} inactivo(s)`
                : `${clients.length} cliente${clients.length === 1 ? '' : 's'} activo${clients.length === 1 ? '' : 's'}`}
          </p>
        </div>
        <div className="flex items-center gap-4">
          <Switch checked={showInactive} onChange={() => setShowInactive((v) => !v)} label="Mostrar inactivos" />
          <Button
            size="sm"
            className="rounded-full px-4"
            style={primaryPillStyle}
            onPress={() => {
              setCreateForm(EMPTY_FORM);
              setCreateError(null);
              setShowCreate(true);
            }}
          >
            + Nuevo cliente
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

      {clients && clients.length > 0 && (
        <div className="overflow-x-auto rounded-xl border" style={{ borderColor: 'var(--border)' }}>
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="text-left" style={{ color: 'var(--muted)' }}>
                <th className="px-4 py-2 font-medium">Nombre</th>
                <th className="px-4 py-2 font-medium">Descripción</th>
                <th className="px-4 py-2 font-medium">Carpeta local</th>
                <th className="px-4 py-2 font-medium">Retención</th>
                <th className="px-4 py-2 font-medium">Tareas</th>
                <th className="px-4 py-2 font-medium">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {clients.map((client) => (
                <tr
                  key={client.id}
                  style={{
                    borderTop: '1px solid var(--separator)',
                    opacity: client.isActive ? 1 : 0.55,
                  }}
                >
                  <td className="px-4 py-2.5 font-medium">
                    {client.name}
                    {!client.isActive && (
                      <span className="ml-2 text-xs font-normal" style={{ color: 'var(--muted)' }}>
                        (inactivo)
                      </span>
                    )}
                  </td>
                  <td className="max-w-xs truncate px-4 py-2.5" style={{ color: 'var(--muted)' }} title={client.description ?? undefined}>
                    {client.description ?? '—'}
                  </td>
                  <td className="px-4 py-2.5" style={{ color: 'var(--muted)' }}>
                    {client.localBasePath}
                  </td>
                  <td className="px-4 py-2.5">{formatRetention(client.retentionCount, client.retentionDays)}</td>
                  <td className="px-4 py-2.5">{client.taskCount}</td>
                  <td className="px-4 py-2.5">
                    {client.isActive ? (
                      <div className="flex items-center gap-2">
                        <Button size="sm" variant="ghost" className="rounded-full px-3" onPress={() => startEdit(client)}>
                          Editar
                        </Button>
                        <Button
                          size="sm"
                          className="rounded-full px-3"
                          style={dangerPillStyle}
                          isDisabled={deactivatingId === client.id}
                          onPress={() => handleDeactivate(client)}
                        >
                          {deactivatingId === client.id ? 'Desactivando…' : 'Desactivar'}
                        </Button>
                      </div>
                    ) : (
                      <Button
                        size="sm"
                        className="rounded-full px-3"
                        style={primaryPillStyle}
                        isDisabled={reactivatingId === client.id}
                        onPress={() => handleReactivate(client)}
                      >
                        {reactivatingId === client.id ? 'Reactivando…' : 'Reactivar'}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {clients && clients.length === 0 && (
        <p style={{ color: 'var(--muted)' }}>No hay clientes activos todavía.</p>
      )}

      {showCreate && (
        <Modal title="Nuevo cliente" onClose={() => setShowCreate(false)}>
          <ClientFields values={createForm} onChange={(patch) => setCreateForm((prev) => ({ ...prev, ...patch }))} />
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
              isDisabled={createBusy || !createForm.name.trim() || !createForm.localBasePath.trim()}
              onPress={handleCreate}
            >
              {createBusy ? 'Creando…' : 'Crear'}
            </Button>
          </div>
        </Modal>
      )}

      {editingClient && (
        <Modal title={`Editar "${editingClient.name}"`} onClose={() => setEditingClient(null)}>
          <ClientFields values={editForm} onChange={(patch) => setEditForm((prev) => ({ ...prev, ...patch }))} />
          {editError && (
            <p className="mt-2 text-xs" style={{ color: 'var(--danger)' }}>
              {editError}
            </p>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <Button size="sm" variant="ghost" className="rounded-full px-4" isDisabled={editBusy} onPress={() => setEditingClient(null)}>
              Cancelar
            </Button>
            <Button
              size="sm"
              className="rounded-full px-4"
              style={primaryPillStyle}
              isDisabled={editBusy || !editForm.name.trim() || !editForm.localBasePath.trim()}
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
