import { useEffect, useState } from 'react';
import { Button } from '@heroui/react';
import type { BackupSet } from 'engine-core';
import { fetchBackupSets } from '../lib/backupSetsClient';
import { updateFileBackupTask, setFileBackupTaskSchedule, type FileBackupTask } from '../lib/fileBackupClient';
import { Modal } from './Modal';
import { Field, inputStyle } from './TaskCreateWizard';
import { FileScheduleFields, isFileScheduleValid, type FileScheduleValue } from './FileScheduleFields';
import { primaryPillStyle, dangerPillStyle } from '../lib/pillStyles';

/**
 * Edit a file-backup task from the unified Tareas surfaces — name +
 * retention + backup set (PATCH /file-tasks/:id) and the schedule
 * (POST /file-tasks/:id/schedule). Functional mirror of TaskEditModal.
 */
export function FileTaskEditModal({
  task,
  onClose,
  onSaved,
}: {
  task: FileBackupTask;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(task.name);
  const [retentionCount, setRetentionCount] = useState(task.retentionCount != null ? String(task.retentionCount) : '');
  const [retentionDays, setRetentionDays] = useState(task.retentionDays != null ? String(task.retentionDays) : '');
  const [backupSetId, setBackupSetId] = useState(task.backupSetId ?? '');
  const [backupSets, setBackupSets] = useState<BackupSet[]>([]);
  const [schedule, setSchedule] = useState<FileScheduleValue>({
    time: task.scheduleTime ?? '',
    enabled: task.scheduleEnabled,
    frequency: task.scheduleFrequency,
    daysOfWeek: task.scheduleDaysOfWeek ?? [],
    dayOfMonth: task.scheduleDayOfMonth != null ? String(task.scheduleDayOfMonth) : '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchBackupSets(task.clientId)
      .then(setBackupSets)
      .catch(() => setBackupSets([]));
  }, [task.clientId]);

  async function handleSave(dropSchedule: boolean) {
    setBusy(true);
    setError(null);
    try {
      await updateFileBackupTask(task.id, {
        name: name.trim() || task.name,
        retentionCount: retentionCount ? Number(retentionCount) : null,
        retentionDays: retentionDays ? Number(retentionDays) : null,
        backupSetId: backupSetId || null,
      });
      const clearing = dropSchedule || !schedule.time;
      await setFileBackupTaskSchedule(task.id, {
        scheduleTime: clearing ? task.scheduleTime : schedule.time,
        scheduleEnabled: !clearing && schedule.enabled,
        scheduleFrequency: schedule.frequency,
        scheduleDaysOfWeek: schedule.frequency === 'weekly' ? schedule.daysOfWeek : undefined,
        scheduleDayOfMonth: schedule.frequency === 'monthly' ? Number(schedule.dayOfMonth) : undefined,
        disable: clearing,
      });
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`Editar — ${task.name}`} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <Field label="Nombre">
          <input style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Retención (N snapshots)">
            <input style={inputStyle} type="number" min={0} value={retentionCount} onChange={(e) => setRetentionCount(e.target.value)} />
          </Field>
          <Field label="Retención (días)">
            <input style={inputStyle} type="number" min={0} value={retentionDays} onChange={(e) => setRetentionDays(e.target.value)} />
          </Field>
        </div>

        {backupSets.length > 0 && (
          <Field label="Set de backup">
            <select style={inputStyle} value={backupSetId} onChange={(e) => setBackupSetId(e.target.value)}>
              <option value="">Sin asignar</option>
              {backupSets.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
        )}

        <div className="my-1 border-t" style={{ borderColor: 'var(--separator)' }} />
        <div className="text-sm font-semibold">Horario</div>
        <FileScheduleFields value={schedule} onChange={(p) => setSchedule((s) => ({ ...s, ...p }))} optional />

        {error && (
          <p className="text-xs" style={{ color: 'var(--danger)' }}>
            {error}
          </p>
        )}
        <div className="mt-2 flex justify-end gap-2">
          <Button size="sm" variant="ghost" className="rounded-full px-4" onPress={onClose}>
            Cancelar
          </Button>
          {task.scheduleTime && (
            <Button size="sm" className="rounded-full px-4" style={dangerPillStyle} isDisabled={busy} onPress={() => handleSave(true)}>
              Quitar horario
            </Button>
          )}
          <Button
            size="sm"
            className="rounded-full px-4"
            style={primaryPillStyle}
            isDisabled={busy || !isFileScheduleValid(schedule)}
            onPress={() => handleSave(false)}
          >
            {busy ? 'Guardando…' : 'Guardar'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
