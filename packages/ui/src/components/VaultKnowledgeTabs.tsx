import { useCallback, useEffect, useState } from 'react';
import { Button } from '@heroui/react';
import type { VaultItem, VaultItemType, VaultUrl } from 'engine-core';
import { Modal } from './Modal';
import { IconButton } from './IconButton';
import { CopyIcon, EditIcon, EyeIcon, TrashIcon } from './icons';
import { primaryPillStyle } from '../lib/pillStyles';
import { useVaultStatus } from '../lib/useVaultStatus';
import { useClipboardAutoClear } from '../lib/useClipboardAutoClear';
import {
  createItem,
  createUrl,
  deleteItem,
  deleteUrl,
  fetchClientItems,
  fetchClientUrls,
  revealItemBody,
  updateItem,
  updateUrl,
  type ItemInput,
  type UrlInput,
} from '../lib/vaultClient';

const inputCls = 'w-full rounded-md border px-3 py-2 text-sm outline-none';
const inputStyle = { backgroundColor: 'var(--field-background)', borderColor: 'var(--border)' } as const;

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs" style={{ color: 'var(--muted)' }}>
        {label}
      </span>
      {children}
    </label>
  );
}

// ---------------------------------------------------------------- URLs tab
export function UrlsTab({ clientId }: { clientId: string }) {
  const [urls, setUrls] = useState<VaultUrl[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<VaultUrl | null>(null);
  const [creating, setCreating] = useState(false);
  const { copy, copiedKey } = useClipboardAutoClear();

  const refresh = useCallback(async () => {
    try {
      setUrls(await fetchClientUrls(clientId));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [clientId]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="mt-3 space-y-3">
      <div className="flex justify-end">
        <Button size="sm" className="rounded-full px-4" style={primaryPillStyle} onPress={() => setCreating(true)}>
          + Nueva URL
        </Button>
      </div>
      {error && (
        <p className="text-sm" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      )}
      <div className="overflow-x-auto rounded-lg border" style={{ borderColor: 'var(--border)' }}>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left" style={{ color: 'var(--muted)' }}>
              <th className="px-3 py-2 font-medium">Nombre</th>
              <th className="px-3 py-2 font-medium">URL</th>
              <th className="px-3 py-2 font-medium">Entorno</th>
              <th className="px-3 py-2 font-medium text-right">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {urls?.length === 0 && (
              <tr>
                <td colSpan={4} className="px-3 py-6 text-center" style={{ color: 'var(--muted)' }}>
                  Sin URLs todavía.
                </td>
              </tr>
            )}
            {urls?.map((u) => (
              <tr key={u.id} className="border-t" style={{ borderColor: 'var(--border)' }}>
                <td className="px-3 py-2">
                  {u.favorite ? '★ ' : ''}
                  {u.name}
                </td>
                <td className="px-3 py-2">
                  <a href={u.url} target="_blank" rel="noreferrer" className="underline" style={{ color: 'var(--accent)' }}>
                    {u.url}
                  </a>
                </td>
                <td className="px-3 py-2" style={{ color: 'var(--muted)' }}>
                  {u.environment ?? '—'}
                </td>
                <td className="px-3 py-2">
                  <div className="flex items-center justify-end gap-1">
                    <IconButton
                      icon={<CopyIcon />}
                      label={copiedKey === u.id ? 'copiado' : 'Copiar URL'}
                      onPress={() => void copy(u.url, u.id)}
                    />
                    <IconButton icon={<EditIcon />} label="Editar" onPress={() => setEditing(u)} />
                    <IconButton
                      icon={<TrashIcon />}
                      label="Eliminar"
                      tone="danger"
                      onPress={async () => {
                        if (window.confirm(`Eliminar "${u.name}"?`)) {
                          await deleteUrl(u.id);
                          void refresh();
                        }
                      }}
                    />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(creating || editing) && (
        <UrlFormModal
          clientId={clientId}
          existing={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={() => {
            setCreating(false);
            setEditing(null);
            void refresh();
          }}
        />
      )}
    </div>
  );
}

function UrlFormModal({
  clientId,
  existing,
  onClose,
  onSaved,
}: {
  clientId: string;
  existing: VaultUrl | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<UrlInput>({
    clientId,
    name: existing?.name ?? '',
    url: existing?.url ?? '',
    environment: existing?.environment ?? '',
    tags: existing?.tags ?? [],
    favorite: existing?.favorite ?? false,
    description: existing?.description ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof UrlInput>(k: K, v: UrlInput[K]) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const payload = { ...form, environment: form.environment || null, description: form.description || null };
      if (existing) await updateUrl(existing.id, payload);
      else await createUrl(payload);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={existing ? 'Editar URL' : 'Nueva URL'} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="space-y-3"
      >
        <Field label="Nombre">
          <input className={inputCls} style={inputStyle} value={form.name ?? ''} onChange={(e) => set('name', e.target.value)} required />
        </Field>
        <Field label="URL">
          <input className={inputCls} style={inputStyle} value={form.url ?? ''} onChange={(e) => set('url', e.target.value)} required />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Entorno">
            <input className={inputCls} style={inputStyle} value={form.environment ?? ''} onChange={(e) => set('environment', e.target.value)} />
          </Field>
          <Field label="Tags (coma)">
            <input
              className={inputCls}
              style={inputStyle}
              value={(form.tags ?? []).join(', ')}
              onChange={(e) => set('tags', e.target.value.split(',').map((t) => t.trim()).filter(Boolean))}
            />
          </Field>
        </div>
        <Field label="Descripción">
          <input className={inputCls} style={inputStyle} value={form.description ?? ''} onChange={(e) => set('description', e.target.value)} />
        </Field>
        <label className="flex items-center gap-2 text-xs" style={{ color: 'var(--muted)' }}>
          <input type="checkbox" checked={!!form.favorite} onChange={(e) => set('favorite', e.target.checked)} />
          Fijar
        </label>
        {error && (
          <p className="text-xs" style={{ color: 'var(--danger)' }}>
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onPress={onClose}>
            Cancelar
          </Button>
          <Button size="sm" type="submit" isDisabled={busy}>
            {busy ? 'Guardando…' : 'Guardar'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// -------------------------------------------------- Snippets / Processes / Notes
const TYPE_LABEL: Record<VaultItemType, { singular: string; plural: string }> = {
  snippet: { singular: 'snippet', plural: 'Snippets' },
  process: { singular: 'proceso', plural: 'Procesos' },
  note: { singular: 'nota', plural: 'Notas' },
};

export function ItemsTab({ clientId, type }: { clientId: string; type: VaultItemType }) {
  const { status } = useVaultStatus();
  const [items, setItems] = useState<VaultItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<VaultItem | null>(null);
  const [creating, setCreating] = useState(false);
  const [bodies, setBodies] = useState<Record<string, string>>({});
  const { copy, copiedKey } = useClipboardAutoClear();

  const refresh = useCallback(async () => {
    try {
      setItems(await fetchClientItems(clientId, type));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [clientId, type]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const showBody = async (it: VaultItem) => {
    try {
      const body = await revealItemBody(it.id);
      setBodies((b) => ({ ...b, [it.id]: body }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const locked = (it: VaultItem) => it.isSensitive && !status?.unlocked;

  return (
    <div className="mt-3 space-y-3">
      <div className="flex justify-end">
        <Button size="sm" className="rounded-full px-4" style={primaryPillStyle} onPress={() => setCreating(true)}>
          + {TYPE_LABEL[type].singular}
        </Button>
      </div>
      {error && (
        <p className="text-sm" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      )}
      <div className="space-y-2">
        {items?.length === 0 && (
          <p className="px-1 py-4 text-sm" style={{ color: 'var(--muted)' }}>
            Sin {TYPE_LABEL[type].plural.toLowerCase()} todavía.
          </p>
        )}
        {items?.map((it) => (
          <div key={it.id} className="rounded-lg border p-3" style={{ borderColor: 'var(--border)' }}>
            <div className="flex items-center justify-between">
              <div>
                <span className="font-medium">
                  {it.favorite ? '★ ' : ''}
                  {it.title}
                </span>
                {it.environment && (
                  <span className="ml-2 text-xs" style={{ color: 'var(--muted)' }}>
                    {it.environment}
                  </span>
                )}
                {it.isSensitive && (
                  <span className="ml-2 text-xs" style={{ color: 'var(--warning)' }}>
                    sensible
                  </span>
                )}
                {it.metadata.language && (
                  <span
                    className="ml-2 rounded-full px-2 py-0.5 text-[11px]"
                    style={{ backgroundColor: 'var(--surface-secondary)', color: 'var(--muted)' }}
                  >
                    {it.metadata.language}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1">
                <IconButton
                  icon={<EyeIcon />}
                  label="Ver contenido"
                  disabled={locked(it)}
                  onPress={() => void showBody(it)}
                />
                <IconButton icon={<EditIcon />} label="Editar" onPress={() => setEditing(it)} />
                <IconButton
                  icon={<TrashIcon />}
                  label="Eliminar"
                  tone="danger"
                  onPress={async () => {
                    if (window.confirm(`Eliminar "${it.title}"?`)) {
                      await deleteItem(it.id);
                      void refresh();
                    }
                  }}
                />
              </div>
            </div>
            {it.description && (
              <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
                {it.description}
              </p>
            )}
            {type === 'process' && it.metadata.steps && it.metadata.steps.length > 0 && (
              <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm">
                {it.metadata.steps.map((s, i) => (
                  <li key={i}>
                    {s.text}
                    {s.command && (
                      <div className="mt-1 flex items-center gap-2">
                        <code
                          className="rounded px-2 py-1 text-xs"
                          style={{ backgroundColor: 'var(--surface-secondary)' }}
                        >
                          {s.command}
                        </code>
                        <IconButton
                          icon={<CopyIcon />}
                          label={copiedKey === `${it.id}-${i}` ? 'copiado' : 'Copiar comando'}
                          onPress={() => void copy(s.command!, `${it.id}-${i}`)}
                        />
                      </div>
                    )}
                  </li>
                ))}
              </ol>
            )}
            {it.metadata.warnings && (
              <p className="mt-2 rounded-md px-2 py-1 text-xs" style={{ backgroundColor: 'color-mix(in oklab, var(--warning) 12%, transparent)', color: 'var(--warning)' }}>
                ⚠ {it.metadata.warnings}
              </p>
            )}
            {bodies[it.id] !== undefined && (
              <div className="mt-2 flex items-start gap-2">
                <pre
                  className="flex-1 overflow-x-auto rounded-md p-2 text-xs"
                  style={{ backgroundColor: 'var(--surface-secondary)' }}
                >
                  {bodies[it.id]}
                </pre>
                <IconButton
                  icon={<CopyIcon />}
                  label={copiedKey === it.id ? 'copiado' : 'Copiar'}
                  onPress={() => void copy(bodies[it.id], it.id)}
                />
              </div>
            )}
          </div>
        ))}
      </div>
      {(creating || editing) && (
        <ItemFormModal
          clientId={clientId}
          type={type}
          existing={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={() => {
            setCreating(false);
            setEditing(null);
            void refresh();
          }}
        />
      )}
    </div>
  );
}

function ItemFormModal({
  clientId,
  type,
  existing,
  onClose,
  onSaved,
}: {
  clientId: string;
  type: VaultItemType;
  existing: VaultItem | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<ItemInput>({
    clientId,
    type,
    title: existing?.title ?? '',
    environment: existing?.environment ?? '',
    tags: existing?.tags ?? [],
    description: existing?.description ?? '',
    favorite: existing?.favorite ?? false,
    isSensitive: existing?.isSensitive ?? false,
    metadata: existing?.metadata ?? {},
  });
  const [body, setBody] = useState('');
  const [replaceBody, setReplaceBody] = useState(!existing);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof ItemInput>(k: K, v: ItemInput[K]) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const payload: ItemInput = {
        ...form,
        environment: form.environment || null,
        description: form.description || null,
      };
      if (replaceBody) payload.body = body;
      if (existing) await updateItem(existing.id, payload);
      else await createItem(payload);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`${existing ? 'Editar' : 'Nuevo'} ${TYPE_LABEL[type].singular}`} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="space-y-3"
      >
        <Field label="Título">
          <input className={inputCls} style={inputStyle} value={form.title ?? ''} onChange={(e) => set('title', e.target.value)} required />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Entorno">
            <input className={inputCls} style={inputStyle} value={form.environment ?? ''} onChange={(e) => set('environment', e.target.value)} />
          </Field>
          <Field label="Tags (coma)">
            <input
              className={inputCls}
              style={inputStyle}
              value={(form.tags ?? []).join(', ')}
              onChange={(e) => set('tags', e.target.value.split(',').map((t) => t.trim()).filter(Boolean))}
            />
          </Field>
        </div>
        {type === 'snippet' && (
          <Field label="Lenguaje">
            <input
              className={inputCls}
              style={inputStyle}
              value={form.metadata?.language ?? ''}
              onChange={(e) => set('metadata', { ...form.metadata, language: e.target.value })}
            />
          </Field>
        )}
        <Field label="Descripción">
          <input className={inputCls} style={inputStyle} value={form.description ?? ''} onChange={(e) => set('description', e.target.value)} />
        </Field>
        {type === 'process' && (
          <Field label="Advertencias">
            <input
              className={inputCls}
              style={inputStyle}
              value={form.metadata?.warnings ?? ''}
              onChange={(e) => set('metadata', { ...form.metadata, warnings: e.target.value })}
            />
          </Field>
        )}
        <label className="flex items-center gap-2 text-xs" style={{ color: 'var(--muted)' }}>
          <input type="checkbox" checked={!!form.isSensitive} onChange={(e) => set('isSensitive', e.target.checked)} />
          Marcar como sensible (cuerpo cifrado con la contraseña maestra)
        </label>
        <label className="flex items-center gap-2 text-xs" style={{ color: 'var(--muted)' }}>
          <input type="checkbox" checked={!!form.favorite} onChange={(e) => set('favorite', e.target.checked)} />
          Fijar
        </label>
        {existing && (
          <label className="flex items-center gap-2 text-xs" style={{ color: 'var(--muted)' }}>
            <input type="checkbox" checked={replaceBody} onChange={(e) => setReplaceBody(e.target.checked)} />
            Reemplazar el contenido
          </label>
        )}
        {replaceBody && (
          <Field label={type === 'process' ? 'Contenido (pasos como texto libre)' : 'Contenido'}>
            <textarea className={inputCls} style={inputStyle} rows={5} value={body} onChange={(e) => setBody(e.target.value)} />
          </Field>
        )}
        {error && (
          <p className="text-xs" style={{ color: 'var(--danger)' }}>
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onPress={onClose}>
            Cancelar
          </Button>
          <Button size="sm" type="submit" isDisabled={busy}>
            {busy ? 'Guardando…' : 'Guardar'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// Resumen del cliente vive ahora en ./ClienteResumen (transversal a Backups + Proyecto).
