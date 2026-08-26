import { Fragment, useCallback, useEffect, useState } from 'react';
import { Button } from '@heroui/react';
import { isTauri } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { openPath } from '@tauri-apps/plugin-opener';
import type { BackupSet, ConnectionTestResult } from 'engine-core';
import { fetchBackupSets } from '../lib/backupSetsClient';
import {
  fetchFileBackupRepository,
  createFileBackupRepository,
  exportFileBackupRepositoryKey,
  runFileBackupMaintenance,
  fetchFileBackupTasks,
  createFileBackupTask,
  deactivateFileBackupTask,
  reactivateFileBackupTask,
  runFileBackupTaskNow,
  testFileBackupTaskConnection,
  setFileBackupTaskSchedule,
  fetchFileBackupRuns,
  restoreFileBackupRun,
  deleteFileBackupRun,
  fileBackupDownloadFileUrl,
  type FileBackupRepository,
  type FileBackupTask,
  type FileBackupRun,
} from '../lib/fileBackupClient';
import { fetchConnections, type TransportWithClientName } from '../lib/connectionsClient';
import { StatusChip } from './StatusChip';
import { IconButton, IconLinkButton } from './IconButton';
import { Modal } from './Modal';
import { Field, inputStyle } from './TaskCreateWizard';
import { PlayIcon, EditIcon, KeyIcon, UndoIcon, DownloadIcon, FolderIcon, PulseIcon, TrashIcon } from './icons';
import { formatDateTime, formatSize, formatSchedule, formatConnectionTestVersions } from '../lib/format';
import { primaryPillStyle, dangerPillStyle } from '../lib/pillStyles';
import { Spinner } from './Spinner';
import { BackupSetBadge } from './BackupSetBadge';

/** Files/dirs metrics can be lower precision than backupsClient's byte formatter needs — reused as-is for dataAddedPacked, the real "physical disk cost" number. */
function RunMetrics({ run }: { run: FileBackupRun }) {
  if (run.status !== 'Success' && run.status !== 'Warning') return <span style={{ color: 'var(--muted)' }}>—</span>;
  return (
    <span className="text-xs" style={{ color: 'var(--muted)' }}>
      +{run.filesNew ?? 0} / ~{run.filesChanged ?? 0} / -{run.filesDeleted ?? 0} · {formatSize(run.dataAddedPacked)} nuevos
    </span>
  );
}

type SourceKind = 'local_folder' | 'remote_folder';

function CreateTaskModal({
  clientId,
  transports,
  onClose,
  onCreated,
}: {
  clientId: string;
  transports: TransportWithClientName[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [sourceKind, setSourceKind] = useState<SourceKind>('local_folder');
  const [sourcePath, setSourcePath] = useState('');
  const [transportId, setTransportId] = useState('');
  const [remoteSourcePath, setRemoteSourcePath] = useState('');
  const [retentionCount, setRetentionCount] = useState('');
  const [retentionDays, setRetentionDays] = useState('');
  const [backupSetId, setBackupSetId] = useState('');
  const [backupSets, setBackupSets] = useState<BackupSet[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchBackupSets(clientId)
      .then(setBackupSets)
      .catch(() => setBackupSets([]));
  }, [clientId]);

  const remoteTransports = transports.filter((t) => t.clientId === clientId && (t.type === 'sftp' || t.type === 'ftp'));

  const valid =
    name.trim().length > 0 &&
    (sourceKind === 'local_folder'
      ? sourcePath.trim().length > 0
      : transportId.length > 0 && remoteSourcePath.trim().length > 0);

  async function handleCreate() {
    setBusy(true);
    setError(null);
    try {
      await createFileBackupTask({
        clientId,
        name: name.trim(),
        sourceKind,
        ...(sourceKind === 'local_folder'
          ? { sourcePath: sourcePath.trim() }
          : { transportId, remoteSourcePath: remoteSourcePath.trim() }),
        retentionCount: retentionCount ? Number(retentionCount) : null,
        retentionDays: retentionDays ? Number(retentionDays) : null,
        backupSetId: backupSetId || null,
      });
      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Nueva tarea de archivos" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <Field label="Nombre *">
          <input style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej: Uploads" />
        </Field>

        <Field label="Origen">
          <div className="flex gap-1">
            <button
              type="button"
              onClick={() => setSourceKind('local_folder')}
              className="rounded-full px-3 py-1 text-xs font-medium"
              style={sourceKind === 'local_folder' ? primaryPillStyle : { color: 'var(--muted)', backgroundColor: 'var(--surface-secondary)' }}
            >
              Carpeta local
            </button>
            <button
              type="button"
              onClick={() => setSourceKind('remote_folder')}
              className="rounded-full px-3 py-1 text-xs font-medium"
              style={sourceKind === 'remote_folder' ? primaryPillStyle : { color: 'var(--muted)', backgroundColor: 'var(--surface-secondary)' }}
            >
              Carpeta remota
            </button>
          </div>
        </Field>

        {sourceKind === 'local_folder' ? (
          <Field label="Carpeta de origen *">
            <div className="flex gap-2">
              <input
                style={{ ...inputStyle, flex: 1 }}
                placeholder="Ej: D:\Sitios\cliente\uploads"
                value={sourcePath}
                onChange={(e) => setSourcePath(e.target.value)}
              />
              {isTauri() && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="shrink-0 rounded-full px-3"
                  onPress={async () => {
                    const selected = await openDialog({ directory: true, multiple: false });
                    if (typeof selected === 'string') setSourcePath(selected);
                  }}
                >
                  Elegir…
                </Button>
              )}
            </div>
          </Field>
        ) : (
          <>
            <Field label="Conexión (SFTP/FTP) *">
              {remoteTransports.length > 0 ? (
                <select style={inputStyle} value={transportId} onChange={(e) => setTransportId(e.target.value)}>
                  <option value="">Elegir…</option>
                  {remoteTransports.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} ({t.type.toUpperCase()} — {t.host})
                    </option>
                  ))}
                </select>
              ) : (
                <p className="text-xs" style={{ color: 'var(--warning)' }}>
                  Este cliente no tiene conexiones SFTP/FTP todavía — creá una en Conexiones primero.
                </p>
              )}
            </Field>
            <Field label="Carpeta remota de origen *">
              <input
                style={inputStyle}
                placeholder="Ej: /home/cliente/uploads"
                value={remoteSourcePath}
                onChange={(e) => setRemoteSourcePath(e.target.value)}
              />
            </Field>
          </>
        )}

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
        {error && (
          <p className="text-xs" style={{ color: 'var(--danger)' }}>
            {error}
          </p>
        )}
        <div className="mt-2 flex justify-end gap-2">
          <Button size="sm" variant="ghost" className="rounded-full px-4" onPress={onClose}>
            Cancelar
          </Button>
          <Button size="sm" className="rounded-full px-4" style={primaryPillStyle} isDisabled={!valid || busy} onPress={handleCreate}>
            {busy ? 'Creando…' : 'Crear'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function RecoveryKeyModal({ recoveryKey, onClose }: { recoveryKey: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <Modal title="Clave de recuperación" onClose={onClose}>
      <p className="mb-3 text-sm" style={{ color: 'var(--warning)' }}>
        Guardá esta clave en un lugar seguro <strong>fuera de esta PC</strong> (gestor de contraseñas, papel, etc.). Es
        indispensable para recuperar estos backups si esta instalación se pierde — arkode la usa automáticamente para las
        corridas programadas, pero no depende únicamente de ella.
      </p>
      <div
        className="mb-3 select-all rounded-md border px-3 py-2 font-mono text-sm break-all"
        style={{ borderColor: 'var(--border)', backgroundColor: 'var(--surface-secondary)' }}
      >
        {recoveryKey}
      </div>
      <div className="flex justify-end gap-2">
        <Button
          size="sm"
          variant="ghost"
          className="rounded-full px-4"
          onPress={async () => {
            await navigator.clipboard.writeText(recoveryKey);
            setCopied(true);
          }}
        >
          {copied ? 'Copiada ✓' : 'Copiar'}
        </Button>
        <Button size="sm" className="rounded-full px-4" style={primaryPillStyle} onPress={onClose}>
          Listo
        </Button>
      </div>
    </Modal>
  );
}

type ScheduleFrequency = 'daily' | 'weekly' | 'monthly';

const FREQUENCY_LABEL: Record<ScheduleFrequency, string> = { daily: 'Diario', weekly: 'Semanal', monthly: 'Mensual' };
const WEEKDAY_LABEL: { value: number; label: string }[] = [
  { value: 1, label: 'Lun' },
  { value: 2, label: 'Mar' },
  { value: 3, label: 'Mié' },
  { value: 4, label: 'Jue' },
  { value: 5, label: 'Vie' },
  { value: 6, label: 'Sáb' },
  { value: 0, label: 'Dom' },
];

function toggleDay(days: number[], day: number): number[] {
  return days.includes(day) ? days.filter((d) => d !== day) : [...days, day].sort();
}

function ScheduleModal({ task, onClose, onSaved }: { task: FileBackupTask; onClose: () => void; onSaved: () => void }) {
  const [time, setTime] = useState(task.scheduleTime ?? '03:00');
  const [enabled, setEnabled] = useState(task.scheduleEnabled);
  const [frequency, setFrequency] = useState<ScheduleFrequency>(task.scheduleFrequency);
  const [daysOfWeek, setDaysOfWeek] = useState<number[]>(task.scheduleDaysOfWeek ?? []);
  const [dayOfMonth, setDayOfMonth] = useState(task.scheduleDayOfMonth != null ? String(task.scheduleDayOfMonth) : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const valid = frequency !== 'weekly' || daysOfWeek.length > 0;

  async function handleSave(disable: boolean) {
    setBusy(true);
    setError(null);
    try {
      await setFileBackupTaskSchedule(task.id, {
        scheduleTime: disable ? task.scheduleTime : time,
        scheduleEnabled: !disable,
        scheduleFrequency: frequency,
        scheduleDaysOfWeek: frequency === 'weekly' ? daysOfWeek : undefined,
        scheduleDayOfMonth: frequency === 'monthly' ? Number(dayOfMonth) : undefined,
        disable,
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
    <Modal title={`Horario — ${task.name}`} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Hora">
            <input style={inputStyle} type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </Field>
          <label className="flex items-end gap-2 pb-2 text-sm" style={{ color: 'var(--muted)' }}>
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            Habilitado
          </label>
        </div>

        <Field label="Frecuencia">
          <div className="flex gap-1">
            {(Object.keys(FREQUENCY_LABEL) as ScheduleFrequency[]).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFrequency(f)}
                className="rounded-full px-3 py-1 text-xs font-medium"
                style={frequency === f ? primaryPillStyle : { color: 'var(--muted)', backgroundColor: 'var(--surface-secondary)' }}
              >
                {FREQUENCY_LABEL[f]}
              </button>
            ))}
          </div>
        </Field>

        {frequency === 'weekly' && (
          <Field label="Días de la semana *">
            <div className="flex gap-1">
              {WEEKDAY_LABEL.map((day) => (
                <button
                  key={day.value}
                  type="button"
                  onClick={() => setDaysOfWeek((prev) => toggleDay(prev, day.value))}
                  className="rounded-full px-2.5 py-1 text-xs font-medium"
                  style={{
                    backgroundColor: daysOfWeek.includes(day.value) ? 'var(--accent)' : 'var(--surface-secondary)',
                    color: daysOfWeek.includes(day.value) ? 'white' : 'var(--muted)',
                  }}
                >
                  {day.label}
                </button>
              ))}
            </div>
            {daysOfWeek.length === 0 && (
              <p className="text-xs" style={{ color: 'var(--danger)' }}>
                Elegí al menos un día.
              </p>
            )}
          </Field>
        )}

        {frequency === 'monthly' && (
          <Field label="Día del mes *">
            <input
              style={inputStyle}
              type="number"
              min={1}
              max={31}
              placeholder="Ej: 15"
              value={dayOfMonth}
              onChange={(e) => setDayOfMonth(e.target.value)}
            />
            <p className="text-xs" style={{ color: 'var(--muted)' }}>
              Si el mes tiene menos días, se ejecuta el último día del mes.
            </p>
          </Field>
        )}

        {error && (
          <p className="text-xs" style={{ color: 'var(--danger)' }}>
            {error}
          </p>
        )}
        <div className="mt-2 flex justify-end gap-2">
          <Button size="sm" variant="ghost" className="rounded-full px-4" onPress={onClose}>
            Cancelar
          </Button>
          <Button size="sm" className="rounded-full px-4" style={dangerPillStyle} isDisabled={busy} onPress={() => handleSave(true)}>
            Deshabilitar
          </Button>
          <Button size="sm" className="rounded-full px-4" style={primaryPillStyle} isDisabled={busy || !enabled || !valid} onPress={() => handleSave(false)}>
            {busy ? 'Guardando…' : 'Guardar'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

interface TestConnState {
  busy?: boolean;
  result?: ConnectionTestResult;
  error?: string;
}

export function FileBackupsPanel({ clientId }: { clientId: string }) {
  const [repository, setRepository] = useState<FileBackupRepository | null | undefined>(undefined);
  const [tasks, setTasks] = useState<FileBackupTask[]>([]);
  const [runs, setRuns] = useState<FileBackupRun[]>([]);
  const [transports, setTransports] = useState<TransportWithClientName[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creatingRepo, setCreatingRepo] = useState(false);
  const [showRecoveryKey, setShowRecoveryKey] = useState<string | null>(null);
  const [showCreateTask, setShowCreateTask] = useState(false);
  const [schedulingTask, setSchedulingTask] = useState<FileBackupTask | null>(null);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const [testState, setTestState] = useState<Record<string, TestConnState>>({});
  const [restoreMessage, setRestoreMessage] = useState<string | null>(null);
  const [restoredPath, setRestoredPath] = useState<string | null>(null);
  const [downloadRunId, setDownloadRunId] = useState<string | null>(null);
  const [deletingRunId, setDeletingRunId] = useState<string | null>(null);
  const [downloadPath, setDownloadPath] = useState('');

  const refresh = useCallback(async () => {
    try {
      const repo = await fetchFileBackupRepository(clientId);
      setRepository(repo);
      if (repo) {
        const [taskList, runList, connections] = await Promise.all([
          fetchFileBackupTasks(clientId, { includeInactive: true }),
          fetchFileBackupRuns({ clientId, limit: 20 }),
          fetchConnections(),
        ]);
        setTasks(taskList);
        setRuns(runList);
        setTransports(connections.transports);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo conectar con el motor de backups de archivos.');
    }
  }, [clientId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function handleCreateRepo() {
    setCreatingRepo(true);
    setError(null);
    try {
      const created = await createFileBackupRepository(clientId);
      setShowRecoveryKey(created.recoveryKey);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreatingRepo(false);
    }
  }

  async function handleExportKey() {
    if (!repository) return;
    try {
      const key = await exportFileBackupRepositoryKey(repository.id);
      setShowRecoveryKey(key);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleRunTask(taskId: string) {
    setBusyTaskId(taskId);
    setError(null);
    try {
      await runFileBackupTaskNow(taskId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyTaskId(null);
    }
  }

  async function handleTestConnection(taskId: string, trustHost?: boolean) {
    setTestState((prev) => ({ ...prev, [taskId]: { busy: true } }));
    try {
      const result = await testFileBackupTaskConnection(taskId, trustHost);
      setTestState((prev) => ({ ...prev, [taskId]: { result } }));
    } catch (err) {
      setTestState((prev) => ({ ...prev, [taskId]: { error: err instanceof Error ? err.message : String(err) } }));
    }
  }

  async function handleToggleTask(task: FileBackupTask) {
    if (task.isActive && !window.confirm(`¿Desactivar "${task.name}"? Dejará de programarse; su historial no se toca.`)) return;
    setBusyTaskId(task.id);
    try {
      await (task.isActive ? deactivateFileBackupTask(task.id) : reactivateFileBackupTask(task.id));
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyTaskId(null);
    }
  }

  async function handleMaintenance(operation: 'prune' | 'check') {
    if (!repository) return;
    setError(null);
    try {
      await runFileBackupMaintenance(repository.id, operation);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleRestoreRun(run: FileBackupRun) {
    const suggested = `${repository?.repoPath.replace(/\\_restic-repo$/, '') ?? ''}\\_restored\\${run.id.slice(0, 8)}`;
    const target = window.prompt('Carpeta donde restaurar este snapshot completo:', suggested);
    if (!target) return;
    setRestoreMessage(null);
    setRestoredPath(null);
    try {
      const result = await restoreFileBackupRun(run.id, target);
      setRestoredPath(result.targetDir);
      setRestoreMessage(
        result.warning
          ? `Restaurado con una advertencia no fatal (${result.filesRestored} archivos): ${result.warning}`
          : `Restaurado correctamente: ${result.filesRestored} archivos.`
      );
    } catch (err) {
      setRestoreMessage(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleDeleteRun(run: FileBackupRun) {
    if (!window.confirm('¿Eliminar este snapshot? El espacio en disco recién se libera en el próximo prune.')) return;
    setDeletingRunId(run.id);
    setRestoreMessage(null);
    try {
      await deleteFileBackupRun(run.id);
      await refresh();
    } catch (err) {
      setRestoreMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingRunId(null);
    }
  }

  if (repository === undefined) {
    return <Spinner />;
  }

  if (repository === null) {
    return (
      <div className="flex flex-col items-start gap-3">
        {error && (
          <p className="text-sm" style={{ color: 'var(--danger)' }}>
            {error}
          </p>
        )}
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
          Este cliente todavía no tiene un repositorio de backups de archivos. Se comparte entre todas sus tareas de
          archivos (una carpeta por tarea).
        </p>
        <Button size="sm" className="rounded-full px-4" style={primaryPillStyle} isDisabled={creatingRepo} onPress={handleCreateRepo}>
          {creatingRepo ? 'Creando…' : 'Crear repositorio de backups de archivos'}
        </Button>
        {showRecoveryKey && <RecoveryKeyModal recoveryKey={showRecoveryKey} onClose={() => setShowRecoveryKey(null)} />}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <p className="text-sm" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      )}

      <div className="flex items-center justify-between">
        <p className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--muted)' }}>
          {repository.repoPath}
          <IconButton icon={<KeyIcon />} label="Recuperar clave" onPress={handleExportKey} />
        </p>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" className="rounded-full px-3" onPress={() => handleMaintenance('prune')}>
            Prune ahora
          </Button>
          <Button size="sm" variant="ghost" className="rounded-full px-3" onPress={() => handleMaintenance('check')}>
            Check ahora
          </Button>
          <Button size="sm" className="rounded-full px-4" style={primaryPillStyle} onPress={() => setShowCreateTask(true)}>
            + Nueva tarea de archivos
          </Button>
        </div>
      </div>

      {tasks.length > 0 ? (
        <div className="overflow-x-auto rounded-xl border" style={{ borderColor: 'var(--border)' }}>
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="text-left" style={{ color: 'var(--muted)' }}>
                <th className="px-4 py-2 font-medium">Nombre</th>
                <th className="px-4 py-2 font-medium">Origen</th>
                <th className="px-4 py-2 font-medium">Horario</th>
                <th className="px-4 py-2 font-medium">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => {
                const test = testState[task.id];
                const hasDetail = task.sourceKind === 'remote_folder' && Boolean(test?.result || test?.error);
                const transportName = task.transportId ? transports.find((t) => t.id === task.transportId)?.name : null;
                return (
                  <Fragment key={task.id}>
                    <tr style={{ borderTop: '1px solid var(--separator)', opacity: task.isActive ? 1 : 0.55 }}>
                      <td className="px-4 py-2.5 font-medium">
                        {task.name}
                        <BackupSetBadge name={task.backupSetName} />
                      </td>
                      <td className="px-4 py-2.5 text-xs" style={{ color: 'var(--muted)' }}>
                        {task.sourceKind === 'local_folder'
                          ? task.sourcePath
                          : `${transportName ?? '?'} — ${task.remoteSourcePath}`}
                      </td>
                      <td className="px-4 py-2.5" style={{ color: 'var(--muted)' }}>
                        {formatSchedule(task)}
                      </td>
                      <td className="px-4 py-2.5">
                        {task.isActive ? (
                          <div className="flex items-center gap-2">
                            <Button
                              size="sm"
                              className="rounded-full px-3"
                              style={primaryPillStyle}
                              isDisabled={busyTaskId === task.id}
                              onPress={() => handleRunTask(task.id)}
                            >
                              {busyTaskId === task.id ? (
                                <span className="flex items-center gap-1.5">
                                  <Spinner />
                                  Ejecutando…
                                </span>
                              ) : (
                                <span className="flex items-center gap-1.5">
                                  <PlayIcon className="h-3.5 w-3.5" />
                                  Ejecutar ahora
                                </span>
                              )}
                            </Button>
                            {task.sourceKind === 'remote_folder' && (
                              <IconButton
                                icon={<PulseIcon />}
                                label={test?.busy ? 'Probando conexión…' : 'Probar conexión'}
                                disabled={Boolean(test?.busy)}
                                onPress={() => handleTestConnection(task.id)}
                              />
                            )}
                            <IconButton icon={<EditIcon />} label="Editar horario" onPress={() => setSchedulingTask(task)} />
                            <Button
                              size="sm"
                              className="rounded-full px-3"
                              style={dangerPillStyle}
                              isDisabled={busyTaskId === task.id}
                              onPress={() => handleToggleTask(task)}
                            >
                              Desactivar
                            </Button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-2">
                            <span className="text-xs" style={{ color: 'var(--muted)' }}>
                              (inactiva)
                            </span>
                            <Button
                              size="sm"
                              className="rounded-full px-3"
                              style={primaryPillStyle}
                              isDisabled={busyTaskId === task.id}
                              onPress={() => handleToggleTask(task)}
                            >
                              Reactivar
                            </Button>
                          </div>
                        )}
                      </td>
                    </tr>
                    {hasDetail && (
                      <tr style={{ backgroundColor: 'color-mix(in oklab, var(--muted) 8%, transparent)' }}>
                        <td colSpan={4} className="px-4 py-2 text-xs">
                          {test?.error && <span style={{ color: 'var(--danger)' }}>Error: {test.error}</span>}
                          {test?.result && !test.result.unknownHost && (
                            <span style={{ color: test.result.ok ? 'var(--success)' : 'var(--danger)' }}>
                              {test.result.ok ? 'Conexión OK' : 'Conexión fallida'}
                              {test.result.message ? ` — ${test.result.message}` : ''}
                              {test.result.latencyMs != null ? ` (${test.result.latencyMs} ms)` : ''}
                              {formatConnectionTestVersions(test.result)}
                            </span>
                          )}
                          {test?.result?.unknownHost && (
                            <div
                              className="flex flex-wrap items-center gap-2"
                              style={{ color: test.result.unknownHost.previousFingerprintSha256 ? 'var(--danger)' : 'var(--warning)' }}
                            >
                              <span>
                                {test.result.unknownHost.previousFingerprintSha256 ? (
                                  <>
                                    ⚠ La clave del host cambió — ahora {test.result.unknownHost.fingerprintSha256}, antes{' '}
                                    {test.result.unknownHost.previousFingerprintSha256}. Confirmá con quien administra el
                                    servidor antes de confiar.
                                  </>
                                ) : (
                                  <>
                                    Host desconocido — {test.result.unknownHost.keyType} {test.result.unknownHost.fingerprintSha256}.
                                    ¿Confiás en este host?
                                  </>
                                )}
                              </span>
                              <Button
                                size="sm"
                                className="rounded-full px-3"
                                style={primaryPillStyle}
                                isDisabled={test.busy}
                                onPress={() => handleTestConnection(task.id, true)}
                              >
                                Confiar y probar de nuevo
                              </Button>
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
          Este cliente no tiene tareas de archivos todavía.
        </p>
      )}

      {restoreMessage && (
        <div
          className="flex items-center justify-between rounded-md border px-4 py-2 text-sm"
          style={{ borderColor: 'var(--border)', backgroundColor: 'var(--surface-secondary)' }}
        >
          <span>{restoreMessage}</span>
          {restoredPath && isTauri() && (
            <IconButton icon={<FolderIcon />} label="Abrir carpeta" onPress={() => openPath(restoredPath)} />
          )}
        </div>
      )}

      {runs.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-semibold">Snapshots recientes</h3>
          <div className="overflow-x-auto rounded-xl border" style={{ borderColor: 'var(--border)' }}>
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="text-left" style={{ color: 'var(--muted)' }}>
                  <th className="px-4 py-2 font-medium">Fecha</th>
                  <th className="px-4 py-2 font-medium">Estado</th>
                  <th className="px-4 py-2 font-medium">Nuevos/mod./elim.</th>
                  <th className="px-4 py-2 font-medium">Acciones</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id} style={{ borderTop: '1px solid var(--separator)' }}>
                    <td className="px-4 py-2.5">{formatDateTime(run.startedAt)}</td>
                    <td className="px-4 py-2.5">
                      <StatusChip status={run.status} />
                    </td>
                    <td className="px-4 py-2.5">
                      <RunMetrics run={run} />
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-1">
                        {run.snapshotId && (
                          <>
                            <IconButton icon={<UndoIcon />} label="Restaurar snapshot completo" onPress={() => handleRestoreRun(run)} />
                            <IconButton
                              icon={<DownloadIcon />}
                              label="Restaurar un archivo puntual de este snapshot"
                              onPress={() => setDownloadRunId(downloadRunId === run.id ? null : run.id)}
                            />
                            <IconButton
                              icon={<TrashIcon />}
                              label="Eliminar snapshot"
                              tone="danger"
                              disabled={deletingRunId === run.id}
                              onPress={() => handleDeleteRun(run)}
                            />
                          </>
                        )}
                        {run.errorMessage && (
                          <span className="text-xs" style={{ color: 'var(--danger)' }} title={run.errorMessage}>
                            ⚠
                          </span>
                        )}
                      </div>
                      {downloadRunId === run.id && (
                        <div className="mt-2 flex items-center gap-2">
                          <input
                            style={{ ...inputStyle, width: 260 }}
                            placeholder="Ruta original del archivo, ej: D:\...\uploads\foto.jpg"
                            value={downloadPath}
                            onChange={(e) => setDownloadPath(e.target.value)}
                          />
                          {downloadPath && (
                            <IconLinkButton icon={<DownloadIcon />} label="Descargar" href={fileBackupDownloadFileUrl(run.id, downloadPath)} />
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {showCreateTask && (
        <CreateTaskModal clientId={clientId} transports={transports} onClose={() => setShowCreateTask(false)} onCreated={refresh} />
      )}
      {showRecoveryKey && <RecoveryKeyModal recoveryKey={showRecoveryKey} onClose={() => setShowRecoveryKey(null)} />}
      {schedulingTask && <ScheduleModal task={schedulingTask} onClose={() => setSchedulingTask(null)} onSaved={refresh} />}
    </div>
  );
}
