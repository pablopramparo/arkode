import { Fragment, useCallback, useEffect, useState } from 'react';
import { Button } from '@heroui/react';
import type { VaultCredential, VaultCredentialKind, VaultCredentialSecret } from 'engine-core';
import { Modal } from './Modal';
import { IconButton } from './IconButton';
import { CopyIcon, EditIcon, EyeIcon, EyeOffIcon, TrashIcon } from './icons';
import { primaryPillStyle } from '../lib/pillStyles';
import { useVaultStatus } from '../lib/useVaultStatus';
import { useClipboardAutoClear } from '../lib/useClipboardAutoClear';
import {
  createCredential,
  deleteCredential,
  fetchClientCredentials,
  resyncAllOperational,
  resyncCredential,
  revealCredential,
  updateCredential,
  type CredentialInput,
} from '../lib/vaultClient';

const KINDS: VaultCredentialKind[] = [
  'ssh',
  'sftp',
  'ftp',
  'postgres',
  'mysql',
  'mariadb',
  'smtp',
  'http_basic',
  'web_panel',
  'api',
  'oauth_client',
  'generic_login',
  'generic_secret',
  'ssh_key',
  'custom',
];

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

export function CredencialesTab({ clientId }: { clientId: string }) {
  const { status } = useVaultStatus();
  const [creds, setCreds] = useState<VaultCredential[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<VaultCredential | null>(null);
  const [creating, setCreating] = useState(false);
  const [revealed, setRevealed] = useState<Record<string, VaultCredentialSecret>>({});
  const { copy, copiedKey } = useClipboardAutoClear();

  const refresh = useCallback(async () => {
    try {
      setCreds(await fetchClientCredentials(clientId));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [clientId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const locked = !status?.unlocked;

  const doReveal = async (id: string) => {
    try {
      const secret = await revealCredential(id);
      setRevealed((r) => ({ ...r, [id]: secret }));
      setTimeout(() => setRevealed((r) => { const n = { ...r }; delete n[id]; return n; }), 20_000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const doDelete = async (c: VaultCredential) => {
    if (!window.confirm(`Eliminar la credencial "${c.name}"? El secreto cifrado se borra de forma permanente.`)) return;
    try {
      await deleteCredential(c.id);
      void refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const doRepair = async (c: VaultCredential) => {
    try {
      const r = await resyncCredential(c.id);
      if (!r.ok) setError(r.message ?? 'No se pudo re-sincronizar.');
      void refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const doResyncAll = async () => {
    try {
      const r = await resyncAllOperational(clientId);
      if (!r.allOk) setError('Algunas credenciales no se pudieron re-sincronizar.');
      void refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const anyLinked = (creds ?? []).some((c) => c.linkedTransportId || c.linkedDatabaseConnectionId);

  return (
    <div className="mt-3 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs" style={{ color: 'var(--muted)' }}>
          {locked
            ? 'La bóveda está bloqueada — se ven los datos pero no los secretos. Desbloqueá para revelar o crear.'
            : 'Bóveda abierta.'}
        </p>
        <div className="flex items-center gap-2">
          {anyLinked && (
            <Button size="sm" variant="ghost" className="rounded-full px-4" isDisabled={locked} onPress={doResyncAll}>
              Re-sincronizar secretos operativos
            </Button>
          )}
          <Button size="sm" className="rounded-full px-4" style={primaryPillStyle} isDisabled={locked} onPress={() => setCreating(true)}>
            + Nueva credencial
          </Button>
        </div>
      </div>

      {error && (
        <p className="text-sm" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      )}

      <div className="overflow-x-auto rounded-lg border" style={{ borderColor: 'var(--border)' }}>
        <table className="w-full text-sm">
          <thead>
            <tr style={{ color: 'var(--muted)' }} className="text-left">
              <th className="px-3 py-2 font-medium">Nombre</th>
              <th className="px-3 py-2 font-medium">Tipo</th>
              <th className="px-3 py-2 font-medium">Host / URL</th>
              <th className="px-3 py-2 font-medium">Entorno</th>
              <th className="px-3 py-2 font-medium text-right">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {creds?.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center" style={{ color: 'var(--muted)' }}>
                  Sin credenciales todavía.
                </td>
              </tr>
            )}
            {creds?.map((c) => (
              <Fragment key={c.id}>
                <tr className="border-t" style={{ borderColor: 'var(--border)' }}>
                  <td className="px-3 py-2">
                    {c.favorite ? '★ ' : ''}
                    {c.name}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className="rounded-full px-2 py-0.5 text-xs"
                      style={{ backgroundColor: 'var(--surface-secondary)', color: 'var(--muted)' }}
                    >
                      {c.kind}
                    </span>
                  </td>
                  <td className="px-3 py-2" style={{ color: 'var(--muted)' }}>
                    {c.host ?? c.url ?? '—'}
                    {c.port ? `:${c.port}` : ''}
                  </td>
                  <td className="px-3 py-2" style={{ color: 'var(--muted)' }}>
                    {c.environment ?? '—'}
                    {(c.linkedTransportId || c.linkedDatabaseConnectionId) && (
                      <span
                        className="ml-2 rounded-full px-2 py-0.5 text-[11px]"
                        style={{
                          backgroundColor: 'var(--surface-secondary)',
                          color: c.operationalSyncState === 'error' ? 'var(--danger)' : 'var(--muted)',
                        }}
                        title={c.operationalSyncError ?? undefined}
                      >
                        {c.operationalSyncState === 'error'
                          ? '⚠ sincronización operativa'
                          : c.operationalSyncState === 'pending'
                            ? 'sincronización pendiente'
                            : 'usada para backups'}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-end gap-1">
                      {c.operationalSyncState === 'error' && (
                        <IconButton icon={<EditIcon />} label="Reparar sincronización" disabled={locked} onPress={() => doRepair(c)} />
                      )}
                      <IconButton icon={<EyeIcon />} label="Revelar secreto" disabled={locked} onPress={() => doReveal(c.id)} />
                      <IconButton icon={<EditIcon />} label="Editar" disabled={locked} onPress={() => setEditing(c)} />
                      <IconButton icon={<TrashIcon />} label="Eliminar" tone="danger" onPress={() => doDelete(c)} />
                    </div>
                  </td>
                </tr>
                {revealed[c.id] && (
                  <tr style={{ backgroundColor: 'var(--surface-secondary)' }}>
                    <td colSpan={5} className="px-3 py-2">
                      <div className="flex flex-wrap gap-3 text-xs">
                        {c.username && <CopyField label="usuario" value={c.username} k={`${c.id}-u`} copy={copy} copiedKey={copiedKey} />}
                        {c.host && <CopyField label="host" value={c.host} k={`${c.id}-h`} copy={copy} copiedKey={copiedKey} />}
                        {Object.entries(revealed[c.id]).map(([key, val]) =>
                          typeof val === 'string' ? (
                            <CopyField key={key} label={key} value={val} k={`${c.id}-${key}`} copy={copy} copiedKey={copiedKey} secret />
                          ) : null
                        )}
                        {revealed[c.id].custom &&
                          Object.entries(revealed[c.id].custom!).map(([key, val]) => (
                            <CopyField key={`c-${key}`} label={key} value={val} k={`${c.id}-c-${key}`} copy={copy} copiedKey={copiedKey} secret />
                          ))}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      {(creating || editing) && (
        <CredentialFormModal
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

function CopyField({
  label,
  value,
  k,
  copy,
  copiedKey,
  secret,
}: {
  label: string;
  value: string;
  k: string;
  copy: (v: string, key: string) => Promise<boolean>;
  copiedKey: string | null;
  secret?: boolean;
}) {
  const [shown, setShown] = useState(false);
  const display = copiedKey === k ? 'copiado ✓' : secret && !shown ? '••••••' : value;
  return (
    <span
      className="flex items-center gap-1 rounded-md border px-2 py-1"
      style={{ borderColor: 'var(--border)' }}
    >
      <span style={{ color: 'var(--muted)' }}>{label}:</span>
      <button
        type="button"
        onClick={() => void copy(value, k)}
        className="flex items-center gap-1"
        title={`Copiar ${label}`}
      >
        <span className="max-w-88 truncate font-mono">{display}</span>
        <span className="h-3 w-3 [&>svg]:h-3 [&>svg]:w-3" style={{ color: 'var(--muted)' }}>
          <CopyIcon />
        </span>
      </button>
      {secret && (
        <button
          type="button"
          onClick={() => setShown((s) => !s)}
          className="h-3.5 w-3.5 shrink-0 [&>svg]:h-3.5 [&>svg]:w-3.5"
          style={{ color: 'var(--muted)' }}
          title={shown ? 'Ocultar' : 'Mostrar'}
        >
          {shown ? <EyeOffIcon /> : <EyeIcon />}
        </button>
      )}
    </span>
  );
}

function CredentialFormModal({
  clientId,
  existing,
  onClose,
  onSaved,
}: {
  clientId: string;
  existing: VaultCredential | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<CredentialInput>({
    clientId,
    name: existing?.name ?? '',
    kind: existing?.kind ?? 'generic_login',
    environment: existing?.environment ?? '',
    tags: existing?.tags ?? [],
    host: existing?.host ?? '',
    port: existing?.port ?? null,
    username: existing?.username ?? '',
    databaseName: existing?.databaseName ?? '',
    url: existing?.url ?? '',
    favorite: existing?.favorite ?? false,
    description: existing?.description ?? '',
  });
  const [secret, setSecret] = useState<VaultCredentialSecret>({});
  const [replaceSecret, setReplaceSecret] = useState(!existing);
  const [useForBackups, setUseForBackups] = useState(
    !!(existing?.linkedTransportId || existing?.linkedDatabaseConnectionId)
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const BRIDGEABLE: VaultCredentialKind[] = ['ssh', 'sftp', 'ftp', 'ssh_key', 'postgres', 'mysql', 'mariadb'];
  const canBridge = BRIDGEABLE.includes((form.kind ?? 'custom') as VaultCredentialKind);
  const linked = !!(existing?.linkedTransportId || existing?.linkedDatabaseConnectionId);

  const set = <K extends keyof CredentialInput>(key: K, value: CredentialInput[K]) => setForm((f) => ({ ...f, [key]: value }));
  const setS = (key: keyof VaultCredentialSecret, value: string) => setSecret((s) => ({ ...s, [key]: value }));

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const payload: CredentialInput = {
        ...form,
        environment: form.environment || null,
        host: form.host || null,
        username: form.username || null,
        databaseName: form.databaseName || null,
        url: form.url || null,
        description: form.description || null,
      };
      if (replaceSecret) payload.secret = secret;
      if (canBridge) payload.useForBackups = useForBackups;
      const result = existing ? await updateCredential(existing.id, payload) : await createCredential(payload);
      if (result.operationalSync && !result.operationalSync.ok) {
        setError(
          `La credencial se guardó, pero la copia operativa para backups falló: ${
            result.operationalSync.message ?? 'error desconocido'
          }. Usá "Reparar" desde la lista.`
        );
        return;
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={existing ? 'Editar credencial' : 'Nueva credencial'} onClose={onClose}>
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
        <Field label="Tipo">
          <select
            className={inputCls}
            style={inputStyle}
            value={form.kind}
            disabled={linked}
            onChange={(e) => set('kind', e.target.value as VaultCredentialKind)}
          >
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          {linked && (
            <span className="text-[11px]" style={{ color: 'var(--muted)' }}>
              Desvinculá de backups para cambiar el tipo.
            </span>
          )}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Host">
            <input className={inputCls} style={inputStyle} value={form.host ?? ''} onChange={(e) => set('host', e.target.value)} />
          </Field>
          <Field label="Puerto">
            <input
              className={inputCls}
              style={inputStyle}
              type="number"
              value={form.port ?? ''}
              onChange={(e) => set('port', e.target.value ? Number(e.target.value) : null)}
            />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Usuario">
            <input className={inputCls} style={inputStyle} value={form.username ?? ''} onChange={(e) => set('username', e.target.value)} />
          </Field>
          <Field label="Base de datos">
            <input
              className={inputCls}
              style={inputStyle}
              value={form.databaseName ?? ''}
              onChange={(e) => set('databaseName', e.target.value)}
            />
          </Field>
        </div>
        <Field label="URL">
          <input className={inputCls} style={inputStyle} value={form.url ?? ''} onChange={(e) => set('url', e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Entorno">
            <input
              className={inputCls}
              style={inputStyle}
              value={form.environment ?? ''}
              onChange={(e) => set('environment', e.target.value)}
              placeholder="production / integration…"
            />
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
          <input
            className={inputCls}
            style={inputStyle}
            value={form.description ?? ''}
            onChange={(e) => set('description', e.target.value)}
          />
        </Field>
        <label className="flex items-center gap-2 text-xs" style={{ color: 'var(--muted)' }}>
          <input type="checkbox" checked={!!form.favorite} onChange={(e) => set('favorite', e.target.checked)} />
          Fijar (favorito)
        </label>

        {canBridge && (
          <label className="flex items-center gap-2 text-xs" style={{ color: 'var(--muted)' }}>
            <input type="checkbox" checked={useForBackups} onChange={(e) => setUseForBackups(e.target.checked)} />
            Usar para backups (crea/actualiza una copia operativa cifrada con DPAPI para el servicio)
          </label>
        )}

        {existing && (
          <label className="flex items-center gap-2 text-xs" style={{ color: 'var(--muted)' }}>
            <input type="checkbox" checked={replaceSecret} onChange={(e) => setReplaceSecret(e.target.checked)} />
            Reemplazar el secreto
          </label>
        )}

        {replaceSecret && (
          <div className="space-y-2 rounded-md border p-3" style={{ borderColor: 'var(--border)' }}>
            <p className="text-xs" style={{ color: 'var(--muted)' }}>
              Valores sensibles (cifrados con la contraseña maestra):
            </p>
            <Field label="Contraseña">
              <input className={inputCls} style={inputStyle} type="password" onChange={(e) => setS('password', e.target.value)} />
            </Field>
            <Field label="Token / secreto">
              <input className={inputCls} style={inputStyle} type="password" onChange={(e) => setS('token', e.target.value)} />
            </Field>
            <Field label="Client secret (OAuth)">
              <input className={inputCls} style={inputStyle} type="password" onChange={(e) => setS('clientSecret', e.target.value)} />
            </Field>
            <Field label="Clave privada (PEM/OpenSSH)">
              <textarea
                className={inputCls}
                style={inputStyle}
                rows={3}
                onChange={(e) => setS('privateKey', e.target.value)}
              />
            </Field>
            <Field label="Passphrase de la clave">
              <input
                className={inputCls}
                style={inputStyle}
                type="password"
                onChange={(e) => setS('privateKeyPassphrase', e.target.value)}
              />
            </Field>
            <Field label="Notas sensibles">
              <textarea className={inputCls} style={inputStyle} rows={2} onChange={(e) => setS('notes', e.target.value)} />
            </Field>
          </div>
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
