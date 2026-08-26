import { useCallback, useEffect, useState } from 'react';
import { Button } from '@heroui/react';
import type { BackupSet } from 'engine-core';
import { fetchBackupSets, createBackupSet, updateBackupSet, deactivateBackupSet, reactivateBackupSet } from '../lib/backupSetsClient';
import { Modal } from './Modal';
import { Field, inputStyle } from './TaskCreateWizard';
import { IconButton } from './IconButton';
import { EditIcon, TrashIcon, UndoIcon } from './icons';
import { Switch } from './Switch';
import { primaryPillStyle } from '../lib/pillStyles';

function NameModal({
  title,
  initialName,
  onClose,
  onSubmit,
}: {
  title: string;
  initialName?: string;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(initialName ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    setBusy(true);
    setError(null);
    try {
      await onSubmit(name.trim());
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={title} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <Field label="Nombre *">
          <input style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej: Sitio principal" autoFocus />
        </Field>
        {error && (
          <p className="text-xs" style={{ color: 'var(--danger)' }}>
            {error}
          </p>
        )}
        <div className="mt-2 flex justify-end gap-2">
          <Button size="sm" variant="ghost" className="rounded-full px-4" onPress={onClose}>
            Cancelar
          </Button>
          <Button size="sm" className="rounded-full px-4" style={primaryPillStyle} isDisabled={!name.trim() || busy} onPress={handleSubmit}>
            {busy ? 'Guardando…' : 'Guardar'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Pure visual/reporting grouping — a named tag per client that ties several
 * tasks (DB-backup and/or file-backup) together for display purposes only.
 * No shared schedule, no "run all," no aggregate health row — see
 * engine-core's BackupSet doc comment. Kept as a compact inline block rather
 * than its own tab, same instinct as FileBackupsPanel's recovery-key/
 * maintenance controls: a small, low-cardinality per-client list doesn't
 * need a whole screen.
 */
export function BackupSetsSection({ clientId }: { clientId: string }) {
  const [sets, setSets] = useState<BackupSet[] | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [renaming, setRenaming] = useState<BackupSet | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setSets(await fetchBackupSets(clientId, { includeInactive: true }));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [clientId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const visible = sets ? (showInactive ? sets : sets.filter((s) => s.isActive)) : [];
  const hasInactive = Boolean(sets?.some((s) => !s.isActive));

  async function handleToggleActive(set: BackupSet) {
    if (
      set.isActive &&
      !window.confirm(`¿Desactivar el set "${set.name}"? Las tareas que lo tengan asignado lo conservan, pero dejará de listarse como activo.`)
    ) {
      return;
    }
    try {
      await (set.isActive ? deactivateBackupSet(set.id) : reactivateBackupSet(set.id));
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="mb-6">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--muted)' }}>
          Sets de backup
        </h2>
        <div className="flex items-center gap-3">
          {hasInactive && <Switch checked={showInactive} onChange={() => setShowInactive((v) => !v)} label="Mostrar inactivos" />}
          <Button size="sm" variant="ghost" className="rounded-full px-3" onPress={() => setShowCreate(true)}>
            + Nuevo set
          </Button>
        </div>
      </div>

      {error && (
        <p className="mb-2 text-xs" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      )}

      {visible.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {visible.map((set) => (
            <div
              key={set.id}
              className="flex items-center gap-1 rounded-full border pl-3 pr-1 py-0.5 text-xs"
              style={{ borderColor: 'var(--border)', opacity: set.isActive ? 1 : 0.55 }}
            >
              <span>
                {set.name}
                {!set.isActive && ' (inactivo)'}
              </span>
              <IconButton icon={<EditIcon />} label="Renombrar" onPress={() => setRenaming(set)} />
              <IconButton
                icon={set.isActive ? <TrashIcon /> : <UndoIcon />}
                label={set.isActive ? 'Desactivar' : 'Reactivar'}
                tone={set.isActive ? 'danger' : 'muted'}
                onPress={() => handleToggleActive(set)}
              />
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs" style={{ color: 'var(--muted)' }}>
          Sin sets todavía — agrupá tareas relacionadas (ej. base de datos + carpeta de uploads de un mismo sitio) bajo un nombre común.
        </p>
      )}

      {showCreate && (
        <NameModal
          title="Nuevo set de backup"
          onClose={() => setShowCreate(false)}
          onSubmit={async (name) => {
            await createBackupSet(clientId, name);
            await refresh();
          }}
        />
      )}
      {renaming && (
        <NameModal
          title={`Renombrar "${renaming.name}"`}
          initialName={renaming.name}
          onClose={() => setRenaming(null)}
          onSubmit={async (name) => {
            await updateBackupSet(renaming.id, name);
            await refresh();
          }}
        />
      )}
    </div>
  );
}
