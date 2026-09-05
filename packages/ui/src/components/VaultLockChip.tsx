import { useState } from 'react';
import { Button } from '@heroui/react';
import { Modal } from './Modal';
import { LockIcon, LockOpenIcon } from './icons';
import { useVaultStatus } from '../lib/useVaultStatus';
import { changeMasterPassword, initVault, lockVault, unlockVault } from '../lib/vaultClient';

const inputCls =
  'w-full rounded-md border px-3 py-2 text-sm outline-none';
const inputStyle = { backgroundColor: 'var(--field-background)', borderColor: 'var(--border)' } as const;

export function VaultLockChip() {
  const { status } = useVaultStatus();
  const [open, setOpen] = useState<null | 'unlock' | 'init' | 'change'>(null);

  if (!status) return null;

  const label = !status.initialized ? 'Bóveda: sin configurar' : status.unlocked ? 'Bóveda abierta' : 'Bóveda bloqueada';
  const color = !status.initialized ? 'var(--muted)' : status.unlocked ? 'var(--success)' : 'var(--warning)';

  const onChipClick = () => {
    if (!status.initialized) setOpen('init');
    else if (status.unlocked) void lockVault();
    else setOpen('unlock');
  };

  return (
    <>
      <button
        type="button"
        onClick={onChipClick}
        title={status.unlocked ? 'Bloquear la bóveda' : label}
        className="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium"
        style={{ borderColor: 'var(--border)', color }}
      >
        <span className="h-3.5 w-3.5 [&>svg]:h-3.5 [&>svg]:w-3.5">
          {status.unlocked ? <LockOpenIcon /> : <LockIcon />}
        </span>
        {label}
      </button>
      {status.initialized && (
        <button
          type="button"
          onClick={() => setOpen('change')}
          className="text-xs underline"
          style={{ color: 'var(--muted)' }}
        >
          contraseña
        </button>
      )}

      {open === 'init' && <SetPasswordModal mode="init" onClose={() => setOpen(null)} />}
      {open === 'change' && <SetPasswordModal mode="change" onClose={() => setOpen(null)} />}
      {open === 'unlock' && <UnlockModal onClose={() => setOpen(null)} />}
    </>
  );
}

function UnlockModal({ onClose }: { onClose: () => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await unlockVault(password);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Desbloquear la bóveda" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="space-y-3"
      >
        <input
          type="password"
          autoFocus
          className={inputCls}
          style={inputStyle}
          placeholder="Contraseña maestra"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && (
          <p className="text-xs" style={{ color: 'var(--danger)' }}>
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onPress={onClose}>
            Cancelar
          </Button>
          <Button size="sm" type="submit" isDisabled={busy || password.length === 0}>
            {busy ? 'Abriendo…' : 'Desbloquear'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function SetPasswordModal({ mode, onClose }: { mode: 'init' | 'change'; onClose: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (next.length < 8) return setError('La contraseña debe tener al menos 8 caracteres.');
    if (next !== confirm) return setError('Las contraseñas no coinciden.');
    setBusy(true);
    setError(null);
    try {
      if (mode === 'init') await initVault(next);
      else await changeMasterPassword(current, next);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={mode === 'init' ? 'Configurar la bóveda' : 'Cambiar la contraseña maestra'} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="space-y-3"
      >
        {mode === 'init' && (
          <p className="text-xs" style={{ color: 'var(--muted)' }}>
            Una sola contraseña protege todas las credenciales. No hay forma de recuperarla si la perdés.
          </p>
        )}
        {mode === 'change' && (
          <input
            type="password"
            className={inputCls}
            style={inputStyle}
            placeholder="Contraseña actual"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        )}
        <input
          type="password"
          className={inputCls}
          style={inputStyle}
          placeholder="Nueva contraseña maestra"
          value={next}
          onChange={(e) => setNext(e.target.value)}
        />
        <input
          type="password"
          className={inputCls}
          style={inputStyle}
          placeholder="Confirmar contraseña"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
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
            {busy ? 'Guardando…' : mode === 'init' ? 'Configurar' : 'Cambiar'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
