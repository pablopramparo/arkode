import { useEffect, useState } from 'react';
import { Button } from '@heroui/react';
import { isTauri } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import type { BackupSet } from 'engine-core';
import { fetchBackupSets } from '../lib/backupSetsClient';
import {
  fetchFileBackupRepository,
  createFileBackupRepository,
  createFileBackupTask,
  type FileBackupRepository,
} from '../lib/fileBackupClient';
import { fetchConnections, type TransportWithClientName } from '../lib/connectionsClient';
import { Modal } from './Modal';
import { Field, inputStyle } from './TaskCreateWizard';
import { FileScheduleFields, EMPTY_FILE_SCHEDULE, isFileScheduleValid, type FileScheduleValue } from './FileScheduleFields';
import { primaryPillStyle } from '../lib/pillStyles';

type SourceKind = 'local_folder' | 'remote_folder';

/**
 * Creating a restic-backed file-backup task, reachable from the unified
 * "+ Agregar backup" flow (global Tareas and the client ficha). Adapted
 * from FileBackupsPanel's old inline CreateTaskModal, plus:
 *  - an optional client selector when `fixedClientId` isn't given
 *  - a "create the client's restic repository first" step, since a file
 *    task can't exist without one (FileBackupsPanel used to own that).
 */
export function FileTaskCreateModal({
  fixedClientId,
  onClose,
  onCreated,
}: {
  fixedClientId?: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [clients, setClients] = useState<{ id: string; name: string }[]>([]);
  const [clientId, setClientId] = useState(fixedClientId ?? '');
  const [transports, setTransports] = useState<TransportWithClientName[]>([]);

  const [repository, setRepository] = useState<FileBackupRepository | null | undefined>(undefined);
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  const [creatingRepo, setCreatingRepo] = useState(false);

  const [name, setName] = useState('');
  const [sourceKind, setSourceKind] = useState<SourceKind>('local_folder');
  const [sourcePath, setSourcePath] = useState('');
  const [transportId, setTransportId] = useState('');
  const [remoteSourcePath, setRemoteSourcePath] = useState('');
  const [retentionCount, setRetentionCount] = useState('');
  const [retentionDays, setRetentionDays] = useState('');
  const [backupSetId, setBackupSetId] = useState('');
  const [backupSets, setBackupSets] = useState<BackupSet[]>([]);
  const [schedule, setSchedule] = useState<FileScheduleValue>(EMPTY_FILE_SCHEDULE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchConnections()
      .then((data) => {
        setClients(data.clients.map((c) => ({ id: c.id, name: c.name })));
        setTransports(data.transports);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!clientId) {
      setRepository(undefined);
      setBackupSets([]);
      return;
    }
    setRepository(undefined);
    fetchFileBackupRepository(clientId)
      .then(setRepository)
      .catch(() => setRepository(null));
    fetchBackupSets(clientId)
      .then(setBackupSets)
      .catch(() => setBackupSets([]));
  }, [clientId]);

  const remoteTransports = transports.filter((t) => t.clientId === clientId && (t.type === 'sftp' || t.type === 'ftp'));

  const valid =
    Boolean(clientId) &&
    Boolean(repository) &&
    name.trim().length > 0 &&
    (sourceKind === 'local_folder'
      ? sourcePath.trim().length > 0
      : transportId.length > 0 && remoteSourcePath.trim().length > 0) &&
    isFileScheduleValid(schedule);

  async function handleCreateRepo() {
    setCreatingRepo(true);
    setError(null);
    try {
      const created = await createFileBackupRepository(clientId);
      setRecoveryKey(created.recoveryKey);
      setRepository(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreatingRepo(false);
    }
  }

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
        ...(schedule.time
          ? {
              scheduleTime: schedule.time,
              scheduleEnabled: schedule.enabled,
              scheduleFrequency: schedule.frequency,
              scheduleDaysOfWeek: schedule.frequency === 'weekly' ? schedule.daysOfWeek : undefined,
              scheduleDayOfMonth: schedule.frequency === 'monthly' ? Number(schedule.dayOfMonth) : undefined,
            }
          : {}),
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
        {!fixedClientId && (
          <Field label="Cliente *">
            <select style={inputStyle} value={clientId} onChange={(e) => setClientId(e.target.value)}>
              <option value="">Elegir…</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
        )}

        {clientId && repository === undefined && (
          <p className="text-xs" style={{ color: 'var(--muted)' }}>
            Cargando repositorio del cliente…
          </p>
        )}

        {clientId && repository === null && (
          <div
            className="rounded-md border px-3 py-2 text-xs"
            style={{ borderColor: 'var(--warning)', color: 'var(--warning)', backgroundColor: 'color-mix(in oklab, var(--warning) 8%, transparent)' }}
          >
            <p className="mb-2">
              Este cliente todavía no tiene repositorio de archivos (restic). Se crea uno solo por cliente y se comparte
              entre todas sus tareas de archivos.
            </p>
            <Button
              size="sm"
              className="rounded-full px-3"
              style={primaryPillStyle}
              isDisabled={creatingRepo}
              onPress={handleCreateRepo}
            >
              {creatingRepo ? 'Creando…' : 'Crear repositorio'}
            </Button>
          </div>
        )}

        {recoveryKey && (
          <div
            className="rounded-md border px-3 py-2 text-xs"
            style={{ borderColor: 'var(--border)', backgroundColor: 'var(--surface-secondary)' }}
          >
            <p className="mb-1" style={{ color: 'var(--warning)' }}>
              Guardá esta clave de recuperación en un lugar seguro fuera de esta PC. Es indispensable para recuperar los
              backups si esta instalación se pierde.
            </p>
            <div className="select-all break-all font-mono">{recoveryKey}</div>
          </div>
        )}

        {repository && (
          <>
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

            <div className="my-1 border-t" style={{ borderColor: 'var(--separator)' }} />
            <div className="text-sm font-semibold">Horario</div>
            <FileScheduleFields value={schedule} onChange={(p) => setSchedule((s) => ({ ...s, ...p }))} optional />
          </>
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
