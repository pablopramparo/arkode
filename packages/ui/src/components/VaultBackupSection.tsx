import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@heroui/react';
import { IconButton } from './IconButton';
import { TrashIcon } from './icons';
import { useVaultStatus } from '../lib/useVaultStatus';
import {
  createVaultBackupTarget,
  fetchVaultBackupRuns,
  fetchVaultBackupTargets,
  removeVaultBackupTarget,
  restoreVault,
  runVaultBackup,
  type VaultBackupRun,
  type VaultBackupTarget,
} from '../lib/vaultClient';

const inputCls = 'rounded-md border px-3 py-2 text-sm outline-none';
const inputStyle = { backgroundColor: 'var(--field-background)', borderColor: 'var(--border)' } as const;

export function VaultBackupSection() {
  const { status } = useVaultStatus();
  const [targets, setTargets] = useState<VaultBackupTarget[]>([]);
  const [runs, setRuns] = useState<VaultBackupRun[]>([]);
  const [newPath, setNewPath] = useState('');
  const [newRetention, setNewRetention] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const [t, r] = await Promise.all([fetchVaultBackupTargets(), fetchVaultBackupRuns()]);
      setTargets(t);
      setRuns(r);
    } catch (e) {
      setMsg({ tone: 'err', text: e instanceof Error ? e.message : String(e) });
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const addTarget = async () => {
    if (!newPath.trim()) return;
    setBusy('add');
    setMsg(null);
    try {
      await createVaultBackupTarget({
        path: newPath.trim(),
        retentionCount: newRetention ? Number(newRetention) : null,
      });
      setNewPath('');
      setNewRetention('');
      void refresh();
    } catch (e) {
      setMsg({ tone: 'err', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  const backupNow = async () => {
    setBusy('backup');
    setMsg(null);
    try {
      const r = await runVaultBackup();
      setMsg({
        tone: r.allOk ? 'ok' : 'err',
        text: r.allOk ? `Copia realizada en ${r.runs.length} destino(s).` : 'Alguna copia falló — ver el historial.',
      });
      void refresh();
    } catch (e) {
      setMsg({ tone: 'err', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  const doRestore = async (file: File) => {
    const password = window.prompt('Contraseña maestra del backup a restaurar:');
    if (!password) return;
    setBusy('restore');
    setMsg(null);
    try {
      const b64 = btoa(String.fromCharCode(...new Uint8Array(await file.arrayBuffer())));
      const r = await restoreVault(b64, password);
      setMsg({
        tone: 'ok',
        text: `Restaurado: ${r.clientsCreated} clientes, ${r.credentialsCreated} credenciales, ${r.urlsCreated} URLs, ${r.itemsCreated} items.${
          r.clientErrors.length ? ` (${r.clientErrors.length} con error)` : ''
        }`,
      });
    } catch (e) {
      setMsg({ tone: 'err', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="space-y-3">
      <h2 className="text-base font-semibold">Bóveda — copia portable</h2>
      <p className="text-xs" style={{ color: 'var(--muted)' }}>
        {status
          ? status.initialized
            ? status.unlocked
              ? 'La bóveda está abierta.'
              : 'La bóveda está bloqueada — desbloqueala para hacer una copia.'
            : 'La bóveda no está configurada.'
          : ''}
      </p>

      <div className="flex flex-wrap items-end gap-2">
        <label className="space-y-1 text-xs" style={{ color: 'var(--muted)' }}>
          Carpeta destino (puede ser una sincronizada por OneDrive/Drive)
          <input className={`${inputCls} block w-96`} style={inputStyle} value={newPath} onChange={(e) => setNewPath(e.target.value)} placeholder="D:\Backups\arkode-vault" />
        </label>
        <label className="space-y-1 text-xs" style={{ color: 'var(--muted)' }}>
          Retención
          <input className={`${inputCls} block w-24`} style={inputStyle} type="number" value={newRetention} onChange={(e) => setNewRetention(e.target.value)} placeholder="N" />
        </label>
        <Button size="sm" isDisabled={busy === 'add'} onPress={addTarget}>
          Agregar destino
        </Button>
      </div>

      {targets.length > 0 && (
        <ul className="space-y-1 text-sm">
          {targets.map((t) => (
            <li key={t.id} className="flex items-center justify-between rounded-md border px-3 py-1.5" style={{ borderColor: 'var(--border)' }}>
              <span>
                {t.path}
                {t.retentionCount ? <span style={{ color: 'var(--muted)' }}> · máx {t.retentionCount}</span> : null}
                {t.lastStatus ? (
                  <span style={{ color: t.lastStatus === 'Success' ? 'var(--success)' : 'var(--danger)' }}> · {t.lastStatus}</span>
                ) : null}
              </span>
              <IconButton
                icon={<TrashIcon />}
                label="Quitar destino"
                tone="danger"
                onPress={async () => {
                  await removeVaultBackupTarget(t.id);
                  void refresh();
                }}
              />
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap gap-2">
        <Button size="sm" isDisabled={busy === 'backup' || !status?.unlocked} onPress={backupNow}>
          {busy === 'backup' ? 'Copiando…' : 'Hacer copia ahora'}
        </Button>
        <Button size="sm" variant="ghost" isDisabled={busy === 'restore'} onPress={() => fileRef.current?.click()}>
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
        <p className="text-sm" style={{ color: msg.tone === 'ok' ? 'var(--success)' : 'var(--danger)' }}>
          {msg.text}
        </p>
      )}

      {runs.length > 0 && (
        <div className="text-xs">
          <div className="mb-1 font-medium" style={{ color: 'var(--muted)' }}>
            Historial
          </div>
          <ul className="space-y-0.5">
            {runs.slice(0, 8).map((r) => (
              <li key={r.id}>
                <span style={{ color: r.status === 'Success' ? 'var(--success)' : 'var(--danger)' }}>{r.status}</span>{' '}
                <span style={{ color: 'var(--muted)' }}>{r.startedAt}</span>
                {r.errorMessage ? <span style={{ color: 'var(--danger)' }}> — {r.errorMessage}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
