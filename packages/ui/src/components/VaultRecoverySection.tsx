import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@heroui/react';
import { isTauri } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { openPath } from '@tauri-apps/plugin-opener';
import { IconButton } from './IconButton';
import { EditIcon, FolderIcon, PulseIcon, TrashIcon } from './icons';
import { Spinner } from './Spinner';
import { Switch } from './Switch';
import { DriveConnectButtons } from './DriveAuthControls';
import { useVaultStatus } from '../lib/useVaultStatus';
import { primaryPillStyle } from '../lib/pillStyles';
import { formatAge, formatDateTime, formatSize } from '../lib/format';
import { fetchClients } from '../lib/clientsClient';
import { fetchReplicationTargets } from '../lib/replicationClient';
import {
  authorizeVaultBackupTarget,
  createVaultBackupDriveTarget,
  createVaultBackupTarget,
  fetchVaultBackupRuns,
  fetchVaultBackupTargets,
  fetchVaultSettings,
  removeVaultBackupTarget,
  runVaultBackup,
  restoreVault,
  testVaultBackupTarget,
  updateVaultBackupTarget,
  updateVaultSettings,
  type VaultBackupRun,
  type VaultBackupTarget,
} from '../lib/vaultClient';

const inputCls = 'rounded-md border px-3 py-2 text-sm outline-none';
const inputStyle = { backgroundColor: 'var(--field-background)', borderColor: 'var(--border)' } as const;

interface DriveAccount {
  replicationTargetId: string;
  label: string;
}

function targetStatusTone(t: VaultBackupTarget): string {
  if (t.lastStatus === 'Success') return 'var(--success)';
  if (t.lastStatus === 'Failed') return 'var(--danger)';
  return 'var(--muted)';
}

/** Configured idle auto-lock timeout (0 = never), editable inline. */
function AutoLockControl() {
  const [minutes, setMinutes] = useState<string>('');
  const [saved, setSaved] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void fetchVaultSettings()
      .then((s) => {
        setSaved(s.autoLockMinutes);
        setMinutes(String(s.autoLockMinutes));
      })
      .catch(() => {});
  }, []);

  const dirty = saved != null && minutes !== '' && Number(minutes) !== saved;

  const save = async () => {
    const n = Number(minutes);
    if (!Number.isFinite(n) || n < 0 || n > 1440) return;
    setBusy(true);
    try {
      const s = await updateVaultSettings({ autoLockMinutes: Math.round(n) });
      setSaved(s.autoLockMinutes);
      setMinutes(String(s.autoLockMinutes));
    } finally {
      setBusy(false);
    }
  };

  return (
    <label className="flex flex-wrap items-center gap-2 text-xs" style={{ color: 'var(--muted)' }}>
      Se bloquea sola tras
      <input
        type="number"
        min={0}
        max={1440}
        className={`${inputCls} w-16`}
        style={inputStyle}
        value={minutes}
        onChange={(e) => setMinutes(e.target.value)}
      />
      minutos de inactividad (0 = nunca).
      {dirty && (
        <Button size="sm" variant="ghost" className="rounded-full px-3" isDisabled={busy} onPress={save}>
          {busy ? 'Guardando…' : 'Guardar'}
        </Button>
      )}
    </label>
  );
}

export function VaultRecoverySection() {
  const { status } = useVaultStatus();
  const [targets, setTargets] = useState<VaultBackupTarget[]>([]);
  const [runs, setRuns] = useState<VaultBackupRun[]>([]);
  const [driveAccounts, setDriveAccounts] = useState<DriveAccount[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [adding, setAdding] = useState<null | 'local_dir' | 'google_drive'>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const [t, r] = await Promise.all([fetchVaultBackupTargets(), fetchVaultBackupRuns(12)]);
      setTargets(t);
      setRuns(r);
    } catch (e) {
      setMsg({ tone: 'err', text: e instanceof Error ? e.message : String(e) });
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Already-connected Google accounts from off-site replication, offered for reuse.
  useEffect(() => {
    void (async () => {
      try {
        const clients = await fetchClients({ includeInactive: true });
        const lists = await Promise.all(clients.map((c) => fetchReplicationTargets(c.id).catch(() => [])));
        const accounts: DriveAccount[] = [];
        for (let i = 0; i < clients.length; i++) {
          for (const rt of lists[i]) {
            if (rt.provider === 'rclone_drive' && rt.authorized) {
              accounts.push({ replicationTargetId: rt.id, label: `${clients[i].name} · ${rt.remotePath}` });
            }
          }
        }
        setDriveAccounts(accounts);
      } catch {
        /* best-effort — reuse is a convenience */
      }
    })();
  }, []);

  const unlocked = status?.unlocked === true;
  const initialized = status?.initialized === true;

  const withBusy = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      setMsg({ tone: 'err', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  const backupNow = () =>
    withBusy('backup', async () => {
      const r = await runVaultBackup();
      setMsg({
        tone: r.allOk ? 'ok' : 'err',
        text: r.allOk
          ? `Copia realizada en ${r.runs.length} destino(s).`
          : 'Alguna copia falló — mirá el estado de cada destino.',
      });
      await refresh();
    });

  const doRestore = (file: File) =>
    withBusy('restore', async () => {
      const password = window.prompt('Contraseña maestra del backup a restaurar:');
      if (!password) return;
      const b64 = btoa(String.fromCharCode(...new Uint8Array(await file.arrayBuffer())));
      const r = await restoreVault(b64, password);
      const parts = [
        `${r.clientsCreated} clientes`,
        `${r.credentialsCreated} credenciales`,
        `${r.replicationTargetsCreated} replicaciones`,
        `${r.vaultBackupTargetsCreated} destinos de recuperación`,
      ];
      setMsg({
        tone: 'ok',
        text:
          `Restaurado: ${parts.join(', ')}.` +
          (r.clientErrors.length ? ` (${r.clientErrors.length} con error)` : '') +
          (r.warnings.length ? `\n⚠ ${r.warnings.join('\n⚠ ')}` : ''),
      });
      await refresh();
    });

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-base font-semibold">Recuperación de Arkode</h2>
        <p className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>
          Instalación nueva + último <code>.arkvault</code> + contraseña maestra = Arkode operativo. Este archivo lleva la
          configuración y los secretos para reconstruir Arkode en otra máquina; los backups de tus clientes quedan afuera.
          Se genera solo con Arkode abierto y la bóveda desbloqueada (al abrir/desbloquear y cada pocas horas).
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm">
          Bóveda:{' '}
          <span style={{ color: initialized ? (unlocked ? 'var(--success)' : 'var(--warning)') : 'var(--muted)' }}>
            {initialized ? (unlocked ? '● Abierta' : '● Bloqueada') : 'sin configurar'}
          </span>
        </span>
        <Button
          size="sm"
          className="rounded-full px-4"
          style={primaryPillStyle}
          isDisabled={busy === 'backup' || !unlocked || targets.filter((t) => t.enabled).length === 0}
          onPress={backupNow}
        >
          {busy === 'backup' ? (
            <span className="flex items-center gap-1.5">
              <Spinner /> Creando…
            </span>
          ) : (
            'Crear backup ahora'
          )}
        </Button>
        {!unlocked && initialized && (
          <span className="text-xs" style={{ color: 'var(--muted)' }}>
            Desbloqueá la bóveda para crear una copia.
          </span>
        )}
      </div>

      {initialized && <AutoLockControl />}
      <p className="text-xs" style={{ color: 'var(--muted)' }}>
        Nota: el Historial del portapapeles de Windows (Win+V) guarda lo que copiás y queda fuera del control de Arkode —
        conviene tenerlo desactivado si copiás secretos.
      </p>

      {/* ── Destinos ─────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium" style={{ color: 'var(--muted)' }}>
          Destinos
        </h3>
        {!adding && (
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" className="rounded-full px-3" onPress={() => setAdding('local_dir')}>
              + Carpeta local
            </Button>
            <Button size="sm" variant="ghost" className="rounded-full px-3" onPress={() => setAdding('google_drive')}>
              + Google Drive
            </Button>
          </div>
        )}
      </div>

      {adding && (
        <AddTargetForm
          kind={adding}
          busy={busy === 'add'}
          onCancel={() => setAdding(null)}
          onSubmit={(input) =>
            withBusy('add', async () => {
              if (input.kind === 'local_dir') {
                await createVaultBackupTarget({ path: input.path, retentionCount: input.retentionCount });
              } else {
                await createVaultBackupDriveTarget({
                  remotePath: input.remotePath,
                  retentionCount: input.retentionCount,
                });
              }
              setAdding(null);
              await refresh();
            })
          }
        />
      )}

      {targets.length === 0 && !adding && (
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
          Todavía no hay ningún destino configurado — sin esto no hay disaster recovery.
        </p>
      )}

      <div className="space-y-3">
        {targets.map((t) => (
          <TargetCard
            key={t.id}
            target={t}
            driveAccounts={driveAccounts}
            busy={busy}
            onChanged={refresh}
            setBusy={setBusy}
            setMsg={setMsg}
          />
        ))}
      </div>

      {/* ── Restore ─────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2 border-t pt-3" style={{ borderColor: 'var(--border)' }}>
        <span className="text-sm" style={{ color: 'var(--muted)' }}>
          En una máquina nueva:
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="rounded-full px-4"
          isDisabled={busy === 'restore'}
          onPress={() => fileRef.current?.click()}
        >
          {busy === 'restore' ? 'Restaurando…' : 'Restaurar desde archivo .arkvault'}
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept=".arkvault,application/json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void doRestore(f);
            e.target.value = '';
          }}
        />
      </div>

      {msg && (
        <p className="whitespace-pre-wrap text-sm" style={{ color: msg.tone === 'ok' ? 'var(--success)' : 'var(--danger)' }}>
          {msg.text}
        </p>
      )}

      {runs.length > 0 && (
        <div className="text-xs">
          <div className="mb-1 font-medium" style={{ color: 'var(--muted)' }}>
            Historial
          </div>
          <ul className="space-y-0.5">
            {runs.slice(0, 10).map((r) => (
              <li key={r.id}>
                <span style={{ color: r.status === 'Success' ? 'var(--success)' : 'var(--danger)' }}>{r.status}</span>{' '}
                <span style={{ color: 'var(--muted)' }}>{formatDateTime(r.startedAt)}</span>
                {r.sizeBytes ? <span style={{ color: 'var(--muted)' }}> · {formatSize(r.sizeBytes)}</span> : null}
                {r.errorMessage ? <span style={{ color: 'var(--danger)' }}> — {r.errorMessage}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- TargetCard
function TargetCard({
  target,
  driveAccounts,
  busy,
  onChanged,
  setBusy,
  setMsg,
}: {
  target: VaultBackupTarget;
  driveAccounts: DriveAccount[];
  busy: string | null;
  onChanged: () => Promise<void>;
  setBusy: (v: string | null) => void;
  setMsg: (v: { tone: 'ok' | 'err'; text: string } | null) => void;
}) {
  const [editingRetention, setEditingRetention] = useState(false);
  const [retention, setRetention] = useState(target.retentionCount?.toString() ?? '');
  const isDrive = target.kind === 'google_drive';
  // The backend reports whether an OAuth token is stored; a prior successful
  // backup is a fallback signal.
  const looksConnected = isDrive && (target.authorized === true || target.lastStatus === 'Success');

  const act = (key: string, fn: () => Promise<void>) => async () => {
    setBusy(key);
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      setMsg({ tone: 'err', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  const saveRetention = act(`ret-${target.id}`, async () => {
    await updateVaultBackupTarget(target.id, { retentionCount: retention ? Number(retention) : null });
    setEditingRetention(false);
    await onChanged();
  });

  return (
    <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border)' }}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium">
            <span
              className="rounded-full px-2 py-0.5 text-[11px]"
              style={{ backgroundColor: 'var(--surface-secondary)', color: 'var(--muted)' }}
            >
              {isDrive ? 'Google Drive' : 'Carpeta local'}
            </span>
            <span className="break-all font-mono">{isDrive ? target.remotePath : target.path}</span>
          </div>
          <div className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs" style={{ color: 'var(--muted)' }}>
            {isDrive && (
              <>
                <span>Cuenta</span>
                <span style={{ color: looksConnected ? 'var(--foreground)' : 'var(--warning)' }}>
                  {target.label ?? (looksConnected ? 'conectada' : 'sin conectar')}
                </span>
              </>
            )}
            <span>Retención</span>
            <span>
              {editingRetention ? (
                <span className="flex items-center gap-1">
                  <input
                    className={`${inputCls} w-20`}
                    style={inputStyle}
                    type="number"
                    value={retention}
                    onChange={(e) => setRetention(e.target.value)}
                  />
                  <Button size="sm" variant="ghost" className="rounded-full px-2" onPress={saveRetention}>
                    ✓
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="rounded-full px-2"
                    onPress={() => {
                      setRetention(target.retentionCount?.toString() ?? '');
                      setEditingRetention(false);
                    }}
                  >
                    ✕
                  </Button>
                </span>
              ) : (
                <span className="flex items-center gap-1.5">
                  {target.retentionCount ? `${target.retentionCount} archivos` : 'sin límite'}
                  <IconButton icon={<EditIcon />} label="Editar retención" onPress={() => setEditingRetention(true)} />
                </span>
              )}
            </span>
            <span>Último backup</span>
            <span style={{ color: targetStatusTone(target) }}>
              {target.lastRunAt ? `${formatAge(target.lastRunAt)} · ` : ''}
              {target.lastStatus === 'Success' ? '✓' : target.lastStatus === 'Failed' ? '✗' : '—'}
              {target.lastError ? ` · ${target.lastError}` : ''}
            </span>
          </div>
        </div>
        <Switch
          checked={target.enabled}
          onChange={act(`en-${target.id}`, async () => {
            await updateVaultBackupTarget(target.id, { enabled: !target.enabled });
            await onChanged();
          })}
          label={target.enabled ? 'Activo' : 'Pausado'}
        />
      </div>

      <div className="mt-2 flex flex-wrap gap-2">
        {isDrive && (
          <DriveConnectButtons
            connected={looksConnected}
            onError={(text) => setMsg({ tone: 'err', text })}
            onAuthorized={async (token) => {
              await authorizeVaultBackupTarget(target.id, token);
              setMsg({ tone: 'ok', text: 'Google Drive conectado.' });
              await onChanged();
            }}
          />
        )}
        {isDrive && driveAccounts.length > 0 && !looksConnected && (
          <select
            className={inputCls}
            style={inputStyle}
            value=""
            onChange={async (e) => {
              const id = e.target.value;
              if (!id) return;
              setBusy(`reuse-${target.id}`);
              setMsg(null);
              try {
                await authorizeVaultBackupTarget(target.id, { reuseFromReplicationTargetId: id });
                setMsg({ tone: 'ok', text: 'Cuenta reutilizada desde Replicación.' });
                await onChanged();
              } catch (err) {
                setMsg({ tone: 'err', text: err instanceof Error ? err.message : String(err) });
              } finally {
                setBusy(null);
              }
            }}
          >
            <option value="">Reutilizar cuenta de Replicación…</option>
            {driveAccounts.map((a) => (
              <option key={a.replicationTargetId} value={a.replicationTargetId}>
                {a.label}
              </option>
            ))}
          </select>
        )}
        {isDrive && (
          <IconButton
            icon={<PulseIcon />}
            label="Probar conexión"
            disabled={busy === `test-${target.id}`}
            onPress={act(`test-${target.id}`, async () => {
              const r = await testVaultBackupTarget(target.id);
              setMsg(
                r.ok
                  ? { tone: 'ok', text: `OK — ${r.detail?.split('\n')[0] ?? 'conectado'}` }
                  : { tone: 'err', text: `Error: ${r.error}` }
              );
            })}
          />
        )}
        {!isDrive && isTauri() && (
          <IconButton
            icon={<FolderIcon />}
            label="Abrir carpeta"
            onPress={async () => {
              try {
                if (target.path) await openPath(target.path);
              } catch {
                /* folder may not exist yet */
              }
            }}
          />
        )}
        <IconButton
          icon={<TrashIcon />}
          label="Quitar destino"
          tone="danger"
          onPress={act(`rm-${target.id}`, async () => {
            if (!window.confirm('¿Quitar este destino? No borra los .arkvault ya escritos.')) return;
            await removeVaultBackupTarget(target.id);
            await onChanged();
          })}
        />
      </div>
    </div>
  );
}

// ------------------------------------------------------------- AddTargetForm
type AddInput =
  | { kind: 'local_dir'; path: string; retentionCount: number | null }
  | { kind: 'google_drive'; remotePath: string; retentionCount: number | null };

function AddTargetForm({
  kind,
  busy,
  onCancel,
  onSubmit,
}: {
  kind: 'local_dir' | 'google_drive';
  busy: boolean;
  onCancel: () => void;
  onSubmit: (input: AddInput) => void;
}) {
  const [path, setPath] = useState('');
  const [remotePath, setRemotePath] = useState('Arkode/Vault');
  const [retention, setRetention] = useState('10');

  const pickFolder = async () => {
    try {
      const picked = await openDialog({ directory: true });
      if (typeof picked === 'string') setPath(picked);
    } catch {
      /* cancelled */
    }
  };

  const submit = () => {
    const retentionCount = retention ? Number(retention) : null;
    if (kind === 'local_dir') {
      if (!path.trim()) return;
      onSubmit({ kind: 'local_dir', path: path.trim(), retentionCount });
    } else {
      if (!remotePath.trim()) return;
      onSubmit({ kind: 'google_drive', remotePath: remotePath.trim(), retentionCount });
    }
  };

  return (
    <div className="rounded-lg border p-3" style={{ borderColor: 'var(--accent)' }}>
      <div className="flex flex-wrap items-end gap-2">
        {kind === 'local_dir' ? (
          <label className="space-y-1 text-xs" style={{ color: 'var(--muted)' }}>
            Carpeta destino (puede ser una sincronizada por OneDrive/Drive)
            <span className="flex items-center gap-2">
              <input
                className={`${inputCls} block w-96`}
                style={inputStyle}
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="D:\Backups\Arkode"
              />
              {isTauri() && (
                <Button size="sm" variant="ghost" className="rounded-full px-3" onPress={pickFolder}>
                  Elegir…
                </Button>
              )}
            </span>
          </label>
        ) : (
          <label className="space-y-1 text-xs" style={{ color: 'var(--muted)' }}>
            Carpeta remota en Google Drive
            <input
              className={`${inputCls} block w-72`}
              style={inputStyle}
              value={remotePath}
              onChange={(e) => setRemotePath(e.target.value)}
              placeholder="Arkode/Vault"
            />
          </label>
        )}
        <label className="space-y-1 text-xs" style={{ color: 'var(--muted)' }}>
          Retención
          <input
            className={`${inputCls} block w-24`}
            style={inputStyle}
            type="number"
            value={retention}
            onChange={(e) => setRetention(e.target.value)}
          />
        </label>
        <Button size="sm" className="rounded-full px-4" style={primaryPillStyle} isDisabled={busy} onPress={submit}>
          {busy ? 'Agregando…' : 'Agregar'}
        </Button>
        <Button size="sm" variant="ghost" className="rounded-full px-3" onPress={onCancel}>
          Cancelar
        </Button>
      </div>
      {kind === 'google_drive' && (
        <p className="mt-2 text-xs" style={{ color: 'var(--muted)' }}>
          Después de agregarlo, conectá una cuenta de Google en la tarjeta del destino.
        </p>
      )}
    </div>
  );
}
