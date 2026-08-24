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
  padding: '4px 8px',
  color: 'var(--foreground)',
  width: '100%',
};

function ClientFields({
  values,
  onChange,
}: {
  values: ClientFormValues;
  onChange: (patch: Partial<ClientFormValues>) => void;
}) {
  return (
    <div className="grid grid-cols-5 gap-2">
      <input
        style={inputStyle}
        placeholder="Nombre *"
        value={values.name}
        onChange={(e) => onChange({ name: e.target.value })}
      />
      <input
        style={inputStyle}
        placeholder="Descripción"
        value={values.description}
        onChange={(e) => onChange({ description: e.target.value })}
      />
      <input
        style={inputStyle}
        placeholder="Carpeta local *"
        value={values.localBasePath}
        onChange={(e) => onChange({ localBasePath: e.target.value })}
      />
      <input
        style={inputStyle}
        placeholder="Retención (N backups)"
        type="number"
        min={0}
        value={values.retentionCount}
        onChange={(e) => onChange({ retentionCount: e.target.value })}
      />
      <input
        style={inputStyle}
        placeholder="Retención (N días)"
        type="number"
        min={0}
        value={values.retentionDays}
        onChange={(e) => onChange({ retentionDays: e.target.value })}
      />
    </div>
  );
}

export function Clientes() {
  const [clients, setClients] = useState<ClientWithTaskCount[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState<ClientFormValues>(EMPTY_FORM);
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<ClientFormValues>(EMPTY_FORM);
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const [deactivatingId, setDeactivatingId] = useState<string | null>(null);
  const [reactivatingId, setReactivatingId] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);

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
    setEditingId(client.id);
    setEditForm(toClientFormValues(client));
    setEditError(null);
  }

  async function handleSaveEdit() {
    if (!editingId) return;
    setEditBusy(true);
    setEditError(null);
    try {
      await updateClient(editingId, toInput(editForm));
      setEditingId(null);
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
    <div className="mx-auto max-w-5xl px-6 py-8">
      <header className="mb-6 flex items-baseline justify-between">
        <div>
          <h1 className="text-xl font-semibold">Clientes</h1>
          <p className="text-sm" style={{ color: 'var(--muted)' }}>
            {clients == null
              ? 'Cargando…'
              : showInactive
                ? `${clients.filter((c) => c.isActive).length} activo(s), ${clients.filter((c) => !c.isActive).length} inactivo(s)`
                : `${clients.length} cliente${clients.length === 1 ? '' : 's'} activo${clients.length === 1 ? '' : 's'}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onPress={() => setShowInactive((v) => !v)}>
            {showInactive ? 'Ocultar inactivos' : 'Mostrar inactivos'}
          </Button>
          <Button size="sm" variant="secondary" onPress={() => setShowCreate((v) => !v)}>
            {showCreate ? 'Cancelar' : '+ Nuevo cliente'}
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

      {showCreate && (
        <div className="mb-4 rounded-lg border p-4" style={{ borderColor: 'var(--border)' }}>
          <ClientFields values={createForm} onChange={(patch) => setCreateForm((prev) => ({ ...prev, ...patch }))} />
          {createError && (
            <p className="mt-2 text-xs" style={{ color: 'var(--danger)' }}>
              {createError}
            </p>
          )}
          <div className="mt-3 flex justify-end gap-2">
            <Button size="sm" variant="ghost" isDisabled={createBusy} onPress={() => setShowCreate(false)}>
              Cancelar
            </Button>
            <Button
              size="sm"
              variant="secondary"
              isDisabled={createBusy || !createForm.name.trim() || !createForm.localBasePath.trim()}
              onPress={handleCreate}
            >
              {createBusy ? 'Creando…' : 'Crear'}
            </Button>
          </div>
        </div>
      )}

      {clients && clients.length > 0 && (
        <div className="overflow-x-auto rounded-lg border" style={{ borderColor: 'var(--border)' }}>
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
              {clients.map((client) => {
                const isEditing = editingId === client.id;
                return (
                  <tr
                    key={client.id}
                    style={{
                      borderTop: '1px solid var(--separator)',
                      opacity: client.isActive ? 1 : 0.55,
                    }}
                  >
                    {isEditing ? (
                      <td className="px-4 py-2.5" colSpan={4}>
                        <ClientFields values={editForm} onChange={(patch) => setEditForm((prev) => ({ ...prev, ...patch }))} />
                        {editError && (
                          <p className="mt-2 text-xs" style={{ color: 'var(--danger)' }}>
                            {editError}
                          </p>
                        )}
                      </td>
                    ) : (
                      <>
                        <td className="px-4 py-2.5 font-medium">
                          {client.name}
                          {!client.isActive && (
                            <span className="ml-2 text-xs font-normal" style={{ color: 'var(--muted)' }}>
                              (inactivo)
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2.5" style={{ color: 'var(--muted)' }}>
                          {client.description ?? '—'}
                        </td>
                        <td className="px-4 py-2.5" style={{ color: 'var(--muted)' }}>
                          {client.localBasePath}
                        </td>
                        <td className="px-4 py-2.5">{formatRetention(client.retentionCount, client.retentionDays)}</td>
                      </>
                    )}
                    <td className="px-4 py-2.5">{client.taskCount}</td>
                    <td className="px-4 py-2.5">
                      {isEditing ? (
                        <div className="flex items-center gap-2">
                          <Button size="sm" variant="ghost" isDisabled={editBusy} onPress={() => setEditingId(null)}>
                            Cancelar
                          </Button>
                          <Button
                            size="sm"
                            variant="secondary"
                            isDisabled={editBusy || !editForm.name.trim() || !editForm.localBasePath.trim()}
                            onPress={handleSaveEdit}
                          >
                            {editBusy ? 'Guardando…' : 'Guardar'}
                          </Button>
                        </div>
                      ) : client.isActive ? (
                        <div className="flex items-center gap-2">
                          <Button size="sm" variant="ghost" onPress={() => startEdit(client)}>
                            Editar
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            isDisabled={deactivatingId === client.id}
                            onPress={() => handleDeactivate(client)}
                          >
                            {deactivatingId === client.id ? 'Desactivando…' : 'Desactivar'}
                          </Button>
                        </div>
                      ) : (
                        <Button
                          size="sm"
                          variant="secondary"
                          isDisabled={reactivatingId === client.id}
                          onPress={() => handleReactivate(client)}
                        >
                          {reactivatingId === client.id ? 'Reactivando…' : 'Reactivar'}
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {clients && clients.length === 0 && !showCreate && (
        <p style={{ color: 'var(--muted)' }}>No hay clientes activos todavía.</p>
      )}
    </div>
  );
}
