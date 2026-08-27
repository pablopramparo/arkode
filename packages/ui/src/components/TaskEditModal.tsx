import { useEffect, useState } from 'react';
import { Button } from '@heroui/react';
import type { BackupSet } from 'engine-core';
import { setTaskSchedule, updateTask, ScheduleCompatibilityError, type TaskRow } from '../lib/tasksClient';
import { fetchBackupSets } from '../lib/backupSetsClient';
import { canRegisterTaskSchedule, registerTaskSchedule } from '../lib/schedulerClient';
import { Modal } from './Modal';
import { primaryPillStyle, dangerPillStyle } from '../lib/pillStyles';
import { EMPTY_FORM, Field, ScheduleFields, inputStyle, isScheduleValid, type FormValues } from './TaskCreateWizard';

function taskToFormValues(task: TaskRow): FormValues {
  return {
    ...EMPTY_FORM,
    clientId: task.clientId,
    name: task.name,
    strategy: task.strategy,
    transportId: task.transportId ?? '',
    databaseConnectionId: task.databaseConnectionId ?? '',
    dbEngine: task.dbEngine,
    retentionCount: task.retentionCount != null ? String(task.retentionCount) : '',
    retentionDays: task.retentionDays != null ? String(task.retentionDays) : '',
    scheduleTime: task.scheduleTime ?? '',
    scheduleEnabled: task.scheduleEnabled,
    scheduleFrequency: task.scheduleFrequency,
    scheduleDaysOfWeek: task.scheduleDaysOfWeek ?? [],
    scheduleDayOfMonth: task.scheduleDayOfMonth != null ? String(task.scheduleDayOfMonth) : '',
    backupSetId: task.backupSetId ?? '',
  };
}

/** Same "shown, not editable" visual as TaskCreateWizard's fixedClientId display — a muted, input-shaped div instead of a real input. */
function ReadOnlyField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Field label={label}>
      <div style={{ ...inputStyle, color: 'var(--muted)' }}>{children}</div>
    </Field>
  );
}

/**
 * The pipeline fields (remoteCommand, dockerContainer, etc.) are
 * deliberately immutable after creation — same reasoning as strategy/
 * transport, see UpdateTaskInput's own doc comment — but that's a reason
 * not to let them be *edited* here, not a reason to hide them entirely.
 * Read directly off `task` (not `values`/FormValues, which only carries
 * the fields this modal actually edits) since there's nothing to route
 * through form state for a read-only display.
 */
function ImmutableTaskDetails({ task }: { task: TaskRow }) {
  if (task.strategy === 'fetch_existing') {
    return (
      <>
        <ReadOnlyField label="Ruta remota">{task.remotePath}</ReadOnlyField>
        {task.remoteFilePattern && <ReadOnlyField label="Patrón de archivo">{task.remoteFilePattern}</ReadOnlyField>}
      </>
    );
  }
  if (task.strategy === 'remote_dump') {
    return (
      <>
        <ReadOnlyField label="Modo de ejecución">
          {task.remoteDumpExecMode === 'docker' ? 'Dentro de un contenedor Docker' : 'Directo en el host'}
        </ReadOnlyField>
        {task.remoteDumpExecMode === 'docker' ? (
          <>
            <ReadOnlyField label="Contenedor">{task.dockerContainer}</ReadOnlyField>
            <div className="grid grid-cols-2 gap-3">
              <ReadOnlyField label="Base de datos">{task.remoteDumpDatabase}</ReadOnlyField>
              <ReadOnlyField label="Usuario de BD">{task.remoteDumpDbUser}</ReadOnlyField>
            </div>
            <ReadOnlyField label="Contraseña de BD">
              {task.remoteDumpDbPasswordSecretRef ? 'Configurada' : 'No configurada'}
            </ReadOnlyField>
          </>
        ) : (
          <ReadOnlyField label="Comando remoto">{task.remoteCommand}</ReadOnlyField>
        )}
        <ReadOnlyField label="Plantilla de ruta de salida">{task.remoteOutputPathTemplate}</ReadOnlyField>
        <ReadOnlyField label="Eliminar archivo remoto">{task.remoteCleanup ? 'Sí' : 'No'}</ReadOnlyField>
      </>
    );
  }
  return null;
}

function EditFields({ task, values, onChange }: { task: TaskRow; values: FormValues; onChange: (patch: Partial<FormValues>) => void }) {
  const [backupSets, setBackupSets] = useState<BackupSet[]>([]);
  useEffect(() => {
    // includeInactive so the currently-assigned set still shows up in the
    // dropdown even if it was deactivated after this task was assigned to it.
    fetchBackupSets(values.clientId, { includeInactive: true })
      .then(setBackupSets)
      .catch(() => setBackupSets([]));
  }, [values.clientId]);

  return (
    <div className="flex flex-col gap-3">
      <Field label="Nombre *">
        <input style={inputStyle} value={values.name} onChange={(e) => onChange({ name: e.target.value })} />
      </Field>
      <ImmutableTaskDetails task={task} />
      <div className="grid grid-cols-2 gap-3">
        <Field label="Retención (N backups)">
          <input
            style={inputStyle}
            type="number"
            min={0}
            value={values.retentionCount}
            onChange={(e) => onChange({ retentionCount: e.target.value })}
          />
        </Field>
        <Field label="Retención (N días)">
          <input
            style={inputStyle}
            type="number"
            min={0}
            value={values.retentionDays}
            onChange={(e) => onChange({ retentionDays: e.target.value })}
          />
        </Field>
      </div>
      {(backupSets.length > 0 || values.backupSetId) && (
        <Field label="Set de backup">
          <select style={inputStyle} value={values.backupSetId} onChange={(e) => onChange({ backupSetId: e.target.value })}>
            <option value="">Sin asignar</option>
            {backupSets.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {!s.isActive ? ' (inactivo)' : ''}
              </option>
            ))}
          </select>
        </Field>
      )}
      <ScheduleFields values={values} onChange={onChange} />
    </div>
  );
}

/** Reused by both Tareas.tsx and ClienteDetalle.tsx's Tareas tab — one edit modal, not two copies of the same form. */
export function TaskEditModal({ task, onClose, onSaved }: { task: TaskRow; onClose: () => void; onSaved: () => void | Promise<void> }) {
  const [form, setForm] = useState<FormValues>(() => taskToFormValues(task));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [compatibilityBlock, setCompatibilityBlock] = useState<ScheduleCompatibilityError | null>(null);
  // See TaskCreateWizard's own identical pattern — registering with Windows
  // Task Scheduler is a separate, elevated step from saving the schedule
  // fields, so an edit that leaves a schedule enabled offers it too, not
  // just creation (e.g. someone enabling a schedule that was off before).
  const [schedulerOffer, setSchedulerOffer] = useState(false);
  const [schedulerBusy, setSchedulerBusy] = useState(false);
  const [schedulerError, setSchedulerError] = useState<string | null>(null);

  async function handleSave(force = false) {
    setBusy(true);
    setError(null);
    try {
      await updateTask(task.id, {
        name: form.name.trim(),
        retentionCount: form.retentionCount.trim() ? Number(form.retentionCount) : null,
        retentionDays: form.retentionDays.trim() ? Number(form.retentionDays) : null,
        backupSetId: form.backupSetId || null,
      });
      await setTaskSchedule(task.id, {
        scheduleTime: form.scheduleTime.trim() || null,
        scheduleEnabled: form.scheduleEnabled,
        scheduleFrequency: form.scheduleFrequency,
        scheduleDaysOfWeek: form.scheduleFrequency === 'weekly' ? form.scheduleDaysOfWeek : undefined,
        scheduleDayOfMonth: form.scheduleFrequency === 'monthly' ? Number(form.scheduleDayOfMonth) : undefined,
        force,
      });
      setCompatibilityBlock(null);
      await onSaved();
      if (canRegisterTaskSchedule() && form.scheduleTime.trim() && form.scheduleEnabled) {
        setSchedulerOffer(true);
      } else {
        onClose();
      }
    } catch (err) {
      if (err instanceof ScheduleCompatibilityError) {
        setCompatibilityBlock(err);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleRegisterScheduler() {
    setSchedulerBusy(true);
    setSchedulerError(null);
    try {
      await registerTaskSchedule(task.id);
      onClose();
    } catch (err) {
      setSchedulerError(err instanceof Error ? err.message : String(err));
    } finally {
      setSchedulerBusy(false);
    }
  }

  if (schedulerOffer) {
    return (
      <Modal title={`Editar "${task.name}"`} onClose={onClose}>
        <p className="text-sm">
          El horario se guardó, pero eso solo actualiza la configuración — activarlo en el Programador de tareas de
          Windows es un paso aparte (necesita permisos de administrador).
        </p>
        {schedulerError && (
          <p className="mt-2 text-xs" style={{ color: 'var(--danger)' }}>
            {schedulerError}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button size="sm" variant="ghost" className="rounded-full px-4" isDisabled={schedulerBusy} onPress={onClose}>
            Ahora no
          </Button>
          <Button size="sm" className="rounded-full px-4" style={primaryPillStyle} isDisabled={schedulerBusy} onPress={handleRegisterScheduler}>
            {schedulerBusy ? 'Activando…' : 'Activar programación (pide permisos)'}
          </Button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={`Editar "${task.name}"`} onClose={onClose}>
      <EditFields task={task} values={form} onChange={(patch) => setForm((prev) => ({ ...prev, ...patch }))} />
      {error && (
        <p className="mt-2 text-xs" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      )}
      {compatibilityBlock && (
        <div className="mt-2 rounded-lg p-3 text-xs" style={{ border: '1px solid var(--danger)', background: 'color-mix(in srgb, var(--danger) 10%, transparent)' }}>
          <p style={{ color: 'var(--danger)' }}>No se pudo activar el horario: {compatibilityBlock.message}</p>
          <p className="mt-1" style={{ color: 'var(--muted)' }}>
            Esto no bloquea "Ejecutar ahora" — sólo la activación automática por horario.
          </p>
          <Button size="sm" className="mt-2 rounded-full px-3" style={dangerPillStyle} isDisabled={busy} onPress={() => handleSave(true)}>
            Forzar y guardar de todos modos
          </Button>
        </div>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <Button size="sm" variant="ghost" className="rounded-full px-4" isDisabled={busy} onPress={onClose}>
          Cancelar
        </Button>
        <Button
          size="sm"
          className="rounded-full px-4"
          style={primaryPillStyle}
          isDisabled={busy || !form.name.trim() || !isScheduleValid(form)}
          onPress={() => handleSave()}
        >
          {busy ? 'Guardando…' : 'Guardar'}
        </Button>
      </div>
    </Modal>
  );
}
