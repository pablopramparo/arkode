import { useCallback, useEffect, useState } from 'react';
import { Button } from '@heroui/react';
import { isTauri } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { openPath } from '@tauri-apps/plugin-opener';
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
  setFileBackupTaskSchedule,
  fetchFileBackupRuns,
  restoreFileBackupRun,
  fileBackupDownloadFileUrl,
  type FileBackupRepository,
  type FileBackupTask,
  type FileBackupRun,
} from '../lib/fileBackupClient';
import { StatusChip } from './StatusChip';
import { IconButton, IconLinkButton } from './IconButton';
import { Modal } from './Modal';
import { Field, inputStyle } from './TaskCreateWizard';
import { PlayIcon, EditIcon, KeyIcon, UndoIcon, DownloadIcon, FolderIcon } from './icons';
import { formatDateTime, formatSize } from '../lib/format';
import { primaryPillStyle, dangerPillStyle } from '../lib/pillStyles';
import { Spinner } from './Spinner';

/** Files/dirs metrics can be lower precision than backupsClient's byte formatter needs — reused as-is for dataAddedPacked, the real "physical disk cost" number. */
function RunMetrics({ run }: { run: FileBackupRun }) {
  if (run.status !== 'Success' && run.status !== 'Warning') return <span style={{ color: 'var(--muted)' }}>—</span>;
  return (
    <span className="text-xs" style={{ color: 'var(--muted)' }}>
      +{run.filesNew ?? 0} / ~{run.filesChanged ?? 0} / -{run.filesDeleted ?? 0} · {formatSize(run.dataAddedPacked)} nuevos
    </span>
  );
}

function CreateTaskModal({
  clientId,
  onClose,
  onCreated,
}: {
  clientId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [sourcePath, setSourcePath] = useState('');
  const [retentionCount, setRetentionCount] = useState('');
  const [retentionDays, setRetentionDays] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const valid = name.trim().length > 0 && sourcePath.trim().length > 0;

  async function handleCreate() {
    setBusy(true);
    setError(null);
    try {
      await createFileBackupTask({
        clientId,
        name: name.trim(),
        sourcePath: sourcePath.trim(),
        retentionCount: retentionCount ? Number(retentionCount) : null,
        retentionDays: retentionDays ? Number(retentionDays) : null,
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
        <div className="grid grid-cols-2 gap-3">
          <Field label="Retención (N snapshots)">
            <input style={inputStyle} type="number" min={0} value={retentionCount} onChange={(e) => setRetentionCount(e.target.value)} />
          </Field>
          <Field label="Retención (días)">
            <input style={inputStyle} type="number" min={0} value={retentionDays} onChange={(e) => setRetentionDays(e.target.value)} />
          </Field>
        </div>
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

function ScheduleModal({ task, onClose, onSaved }: { task: FileBackupTask; onClose: () => void; onSaved: () => void }) {
  const [time, setTime] = useState(task.scheduleTime ?? '03:00');
  const [enabled, setEnabled] = useState(task.scheduleEnabled);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave(disable: boolean) {
    setBusy(true);
    setError(null);
    try {
      await setFileBackupTaskSchedule(task.id, { scheduleTime: disable ? task.scheduleTime : time, scheduleEnabled: !disable, disable });
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
        <p className="text-xs" style={{ color: 'var(--muted)' }}>
          Horario diario simple. Frecuencia semanal/mensual todavía se configura solo por CLI (<code>file-task:set-schedule</code>).
        </p>
        <Field label="Hora">
          <input style={inputStyle} type="time" value={time} onChange={(e) => setTime(e.target.value)} />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Habilitado
        </label>
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
          <Button size="sm" className="rounded-full px-4" style={primaryPillStyle} isDisabled={busy || !enabled} onPress={() => handleSave(false)}>
            {busy ? 'Guardando…' : 'Guardar'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export function FileBackupsPanel({ clientId }: { clientId: string }) {
  const [repository, setRepository] = useState<FileBackupRepository | null | undefined>(undefined);
  const [tasks, setTasks] = useState<FileBackupTask[]>([]);
  const [runs, setRuns] = useState<FileBackupRun[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creatingRepo, setCreatingRepo] = useState(false);
  const [showRecoveryKey, setShowRecoveryKey] = useState<string | null>(null);
  const [showCreateTask, setShowCreateTask] = useState(false);
  const [schedulingTask, setSchedulingTask] = useState<FileBackupTask | null>(null);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const [restoreMessage, setRestoreMessage] = useState<string | null>(null);
  const [restoredPath, setRestoredPath] = useState<string | null>(null);
  const [downloadRunId, setDownloadRunId] = useState<string | null>(null);
  const [downloadPath, setDownloadPath] = useState('');

  const refresh = useCallback(async () => {
    try {
      const repo = await fetchFileBackupRepository(clientId);
      setRepository(repo);
      if (repo) {
        const [taskList, runList] = await Promise.all([
          fetchFileBackupTasks(clientId, { includeInactive: true }),
          fetchFileBackupRuns({ clientId, limit: 20 }),
        ]);
        setTasks(taskList);
        setRuns(runList);
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
              {tasks.map((task) => (
                <tr key={task.id} style={{ borderTop: '1px solid var(--separator)', opacity: task.isActive ? 1 : 0.55 }}>
                  <td className="px-4 py-2.5 font-medium">{task.name}</td>
                  <td className="px-4 py-2.5 text-xs" style={{ color: 'var(--muted)' }}>
                    {task.sourcePath}
                  </td>
                  <td className="px-4 py-2.5" style={{ color: 'var(--muted)' }}>
                    {task.scheduleTime ? `${task.scheduleTime}${task.scheduleEnabled ? '' : ' (deshabilitado)'}` : 'Sin programar'}
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
              ))}
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
        <CreateTaskModal clientId={clientId} onClose={() => setShowCreateTask(false)} onCreated={refresh} />
      )}
      {showRecoveryKey && <RecoveryKeyModal recoveryKey={showRecoveryKey} onClose={() => setShowRecoveryKey(null)} />}
      {schedulingTask && <ScheduleModal task={schedulingTask} onClose={() => setSchedulingTask(null)} onSaved={refresh} />}
    </div>
  );
}
