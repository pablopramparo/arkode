import { useState } from 'react';
import { Button } from '@heroui/react';
import { createDatabaseConnection, createTransport, type ConnectionsData } from '../lib/connectionsClient';
import { Modal } from './Modal';
import { primaryPillStyle } from '../lib/pillStyles';
import { ConnectionFields, EMPTY_FORM, isFormValid, toDatabaseInput, toTransportInput, type FormValues } from './Conexiones';

/** Reused by both Conexiones.tsx and ClienteDetalle.tsx's Conexiones tab — same create form either way, `fixedClientId` locks the client field for the latter. */
export function ConnectionCreateModal({
  clients,
  fixedClientId,
  onClose,
  onCreated,
}: {
  clients: ConnectionsData['clients'];
  fixedClientId?: string;
  onClose: () => void;
  onCreated: () => void | Promise<void>;
}) {
  const [form, setForm] = useState<FormValues>(() => ({ ...EMPTY_FORM, clientId: fixedClientId ?? '' }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCreate() {
    setBusy(true);
    setError(null);
    try {
      if (form.kind === 'transport') await createTransport(toTransportInput(form));
      else await createDatabaseConnection(toDatabaseInput(form));
      onClose();
      await onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Nueva conexión" onClose={onClose}>
      <ConnectionFields
        values={form}
        onChange={(patch) => setForm((prev) => ({ ...prev, ...patch }))}
        clients={clients}
        isCreate
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
        <Button size="sm" className="rounded-full px-4" style={primaryPillStyle} isDisabled={busy || !isFormValid(form)} onPress={handleCreate}>
          {busy ? 'Creando…' : 'Crear'}
        </Button>
      </div>
    </Modal>
  );
}
