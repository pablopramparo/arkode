import { useState } from 'react';
import { Button } from '@heroui/react';
import { updateDatabaseConnection, updateTransport, type ConnectionsData } from '../lib/connectionsClient';
import { Modal } from './Modal';
import { primaryPillStyle } from '../lib/pillStyles';
import {
  ConnectionFields,
  databaseToFormValues,
  isFormValid,
  toDatabaseInput,
  toTransportInput,
  transportToFormValues,
  type ConnectionRow,
} from './Conexiones';

function rowToFormValues(row: ConnectionRow) {
  return row.kind === 'transport' ? transportToFormValues(row.data) : databaseToFormValues(row.data);
}

/** Reused by both Conexiones.tsx and ClienteDetalle.tsx's Conexiones tab — one edit modal, not two copies of the same form. */
export function ConnectionEditModal({
  row,
  clients,
  onClose,
  onSaved,
}: {
  row: ConnectionRow;
  clients: ConnectionsData['clients'];
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [form, setForm] = useState(() => rowToFormValues(row));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setBusy(true);
    setError(null);
    try {
      if (row.kind === 'transport') await updateTransport(row.id, toTransportInput(form));
      else await updateDatabaseConnection(row.id, toDatabaseInput(form));
      onClose();
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`Editar "${row.data.name}"`} onClose={onClose}>
      <ConnectionFields values={form} onChange={(patch) => setForm((prev) => ({ ...prev, ...patch }))} clients={clients} isCreate={false} />
      {error && (
        <p className="mt-2 text-xs" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <Button size="sm" variant="ghost" className="rounded-full px-4" isDisabled={busy} onPress={onClose}>
          Cancelar
        </Button>
        <Button size="sm" className="rounded-full px-4" style={primaryPillStyle} isDisabled={busy || !isFormValid(form)} onPress={handleSave}>
          {busy ? 'Guardando…' : 'Guardar'}
        </Button>
      </div>
    </Modal>
  );
}
