import { useState } from 'react';
import { Button } from '@heroui/react';
import { Modal } from './Modal';

const inputCls = 'w-full rounded-md border px-3 py-2 text-sm outline-none';
const inputStyle = { backgroundColor: 'var(--field-background)', borderColor: 'var(--border)' } as const;

/**
 * Reusable "type the master password to confirm this action" dialog — same
 * plain-Modal + password-field pattern as VaultLockChip's own unlock modal,
 * for the other places that need the master password once (e.g. enabling
 * per-machine auto-unlock from Configuración). `onSubmit` throws to keep the
 * dialog open with an error; resolve to let the caller close it.
 */
export function MasterPasswordModal({
  title,
  description,
  confirmLabel = 'Confirmar',
  onSubmit,
  onClose,
}: {
  title: string;
  description?: string;
  confirmLabel?: string;
  onSubmit: (password: string) => Promise<void>;
  onClose: () => void;
}) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSubmit(password);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={title} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="space-y-3"
      >
        {description && (
          <p className="text-xs" style={{ color: 'var(--muted)' }}>
            {description}
          </p>
        )}
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
            {busy ? 'Guardando…' : confirmLabel}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
