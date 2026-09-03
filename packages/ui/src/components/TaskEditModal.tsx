import { useEffect, useState } from 'react';
import { Button } from '@heroui/react';
import type { BackupSet } from 'engine-core';
import { setTaskSchedule, updateTask, ScheduleCompatibilityError, type TaskRow } from '../lib/tasksClient';
import { fetchBackupSets } from '../lib/backupSetsClient';
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
    remotePath: task.remotePath ?? '',
    remoteFilePattern: task.remoteFilePattern ?? '',
    remoteCommand: task.remoteCommand ?? '',
    remoteOutputPathTemplate: task.remoteOutputPathTemplate ?? '',
    remoteCleanup: task.remoteCleanup,
    remoteDumpExecMode: task.remoteDumpExecMode,
    dockerContainer: task.dockerContainer ?? '',
    remoteDumpDatabase: task.remoteDumpDatabase ?? '',
    remoteDumpDbUser: task.remoteDumpDbUser ?? '',
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

/**
 * Whether the remote-* pipeline fields shown for this task are all filled
 * in acceptably — only meaningful while they're editable (no real backup
 * yet); returns true otherwise so it never blocks a name/schedule-only save.
 */
function isPipelineValid(task: TaskRow, values: FormValues): boolean {
  if (task.hasRealBackups) return true;
  if (task.strategy === 'fetch_existing') return Boolean(values.remotePath.trim());
  if (task.strategy === 'remote_dump') {
    if (!values.remoteOutputPathTemplate.trim()) return false;
    if (task.remoteDumpExecMode === 'host') return Boolean(values.remoteCommand.trim());
    return true;
  }
  return true;
}

/** Same "shown, not editable" visual as TaskCreateWizard's fixedClientId display — a muted, input-shaped div instead of a real input. */
function ReadOnlyField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Field label={label}>
      <div style={{ ...inputStyle, color: 'var(--muted)' }}>{children}</div>
    </Field>
  );
}

function LockedPipelineNote() {
  return (
    <p className="text-xs" style={{ color: 'var(--muted)' }}>
      La tarea ya tiene backups reales, así que su configuración de origen (comando, ruta) no se puede modificar. Creá una
      tarea nueva para cambiarla.
    </p>
  );
}

/**
 * The remote-* pipeline fields. Editable while the task has no real backup
 * yet (task.hasRealBackups === false) — the fix for "created it with the
 * wrong command, now I'm stuck"; the server enforces the same gate. Once a
 * real backup exists they fall back to the previous read-only display.
 * Docker-mode structured fields (container/db/user/password) stay read-only
 * always — changing those is out of scope, create a new task.
 */
function PipelineFields({
  task,
  values,
  onChange,
}: {
  task: TaskRow;
  values: FormValues;
  onChange: (patch: Partial<FormValues>) => void;
}) {
  const editable = !task.hasRealBackups;

  if (task.strategy === 'fetch_existing') {
    return (
      <>
        {editable ? (
          <>
            <Field label="Ruta remota *">
              <input
                style={inputStyle}
                placeholder="Ej: /backups"
                value={values.remotePath}
                onChange={(e) => onChange({ remotePath: e.target.value })}
              />
            </Field>
            <Field label="Patrón de archivo">
              <input
                style={inputStyle}
                placeholder="Ej: *.sql.gz (opcional)"
                value={values.remoteFilePattern}
                onChange={(e) => onChange({ remoteFilePattern: e.target.value })}
              />
            </Field>
          </>
        ) : (
          <>
            <ReadOnlyField label="Ruta remota">{task.remotePath}</ReadOnlyField>
            {task.remoteFilePattern && <ReadOnlyField label="Patrón de archivo">{task.remoteFilePattern}</ReadOnlyField>}
            <LockedPipelineNote />
          </>
        )}
      </>
    );
  }

  if (task.strategy === 'remote_dump') {
    const isDocker = task.remoteDumpExecMode === 'docker';
    return (
      <>
        <ReadOnlyField label="Modo de ejecución">
          {isDocker ? 'Dentro de un contenedor Docker' : 'Directo en el host'}
        </ReadOnlyField>
        {isDocker ? (
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
        ) : editable ? (
          <Field label="Comando remoto *">
            <input
              style={inputStyle}
              placeholder="Ej: mysqldump --single-transaction --quick --no-tablespaces web > {outputPath}"
              value={values.remoteCommand}
              onChange={(e) => onChange({ remoteCommand: e.target.value })}
            />
            <p className="mt-1 text-[11px]" style={{ color: 'var(--muted)' }}>
              Usá <code>{'{outputPath}'}</code> donde va la ruta del dump — arkode lo reemplaza por la ruta que resuelve
              de la plantilla. No uses <code>$(date ...)</code> para el nombre.
            </p>
          </Field>
        ) : (
          <ReadOnlyField label="Comando remoto">{task.remoteCommand}</ReadOnlyField>
        )}
        {editable ? (
          <>
            <Field label="Plantilla de ruta de salida *">
              <input
                style={inputStyle}
                placeholder="Ej: /tmp/backups/db_{date:YYYYMMDD_HHmm}.dump"
                value={values.remoteOutputPathTemplate}
                onChange={(e) => onChange({ remoteOutputPathTemplate: e.target.value })}
              />
            </Field>
            <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--muted)' }}>
              <input
                type="checkbox"
                checked={values.remoteCleanup}
                onChange={(e) => onChange({ remoteCleanup: e.target.checked })}
              />
              Eliminar el archivo remoto tras una descarga exitosa
            </label>
            {isDocker && (
              <p className="text-xs" style={{ color: 'var(--muted)' }}>
                Los campos de Docker (contenedor, base de datos, usuario) no se editan acá — creá una tarea nueva si
                cambiaron.
              </p>
            )}
          </>
        ) : (
          <>
            <ReadOnlyField label="Plantilla de ruta de salida">{task.remoteOutputPathTemplate}</ReadOnlyField>
            <ReadOnlyField label="Eliminar archivo remoto">{task.remoteCleanup ? 'Sí' : 'No'}</ReadOnlyField>
            <LockedPipelineNote />
          </>
        )}
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
      <PipelineFields task={task} values={values} onChange={onChange} />
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

  // The remote-* pipeline fields are only sent when they're actually
  // editable (no real backup yet) and relevant to this task's strategy —
  // the server would reject them otherwise, and there's no point round-
  // tripping unchanged read-only values.
  function pipelinePatch() {
    if (task.hasRealBackups) return {};
    if (task.strategy === 'fetch_existing') {
      return { remotePath: form.remotePath.trim(), remoteFilePattern: form.remoteFilePattern.trim() || null };
    }
    if (task.strategy === 'remote_dump') {
      return {
        remoteCommand: task.remoteDumpExecMode === 'host' ? form.remoteCommand.trim() : undefined,
        remoteOutputPathTemplate: form.remoteOutputPathTemplate.trim(),
        remoteCleanup: form.remoteCleanup,
      };
    }
    return {};
  }

  async function handleSave(force = false) {
    setBusy(true);
    setError(null);
    try {
      await updateTask(task.id, {
        name: form.name.trim(),
        retentionCount: form.retentionCount.trim() ? Number(form.retentionCount) : null,
        retentionDays: form.retentionDays.trim() ? Number(form.retentionDays) : null,
        backupSetId: form.backupSetId || null,
        ...pipelinePatch(),
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
      // No per-task Windows Scheduled Task step: since v0.3.0 the
      // arkode-scheduler Windows Service polls the DB and runs due tasks —
      // a saved schedule is live on its next tick, nothing to "register".
      onClose();
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
          isDisabled={busy || !form.name.trim() || !isScheduleValid(form) || !isPipelineValid(task, form)}
          onPress={() => handleSave()}
        >
          {busy ? 'Guardando…' : 'Guardar'}
        </Button>
      </div>
    </Modal>
  );
}
