import { useCallback, useEffect, useState } from 'react';
import { Button } from '@heroui/react';
import { isTauri } from '@tauri-apps/api/core';
import { openPath } from '@tauri-apps/plugin-opener';
import {
  fetchFileBackupRepository,
  createFileBackupRepository,
  exportFileBackupRepositoryKey,
  runFileBackupMaintenance,
  fetchFileBackupRuns,
  restoreFileBackupRun,
  deleteFileBackupRun,
  fileBackupDownloadFileUrl,
  type FileBackupRepository,
  type FileBackupRun,
} from '../lib/fileBackupClient';
import { StatusChip } from './StatusChip';
import { IconButton, IconLinkButton } from './IconButton';
import { Modal } from './Modal';
import { inputStyle } from './TaskCreateWizard';
import { KeyIcon, UndoIcon, DownloadIcon, FolderIcon, TrashIcon } from './icons';
import { formatDateTime, formatSize } from '../lib/format';
import { primaryPillStyle } from '../lib/pillStyles';
import { Spinner } from './Spinner';

/**
 * The per-client "Repositorio" tab — everything specific to the client's
 * one restic repository: its path, recovery key, maintenance (prune/check),
 * and its snapshot history (browse / restore / delete). File-backup
 * *tasks* are no longer managed here — they live in the unified "Tareas"
 * tab alongside DB-backup tasks.
 */

function RunMetrics({ run }: { run: FileBackupRun }) {
  if (run.status !== 'Success' && run.status !== 'Warning') return <span style={{ color: 'var(--muted)' }}>—</span>;
  return (
    <span className="text-xs" style={{ color: 'var(--muted)' }}>
      +{run.filesNew ?? 0} / ~{run.filesChanged ?? 0} / -{run.filesDeleted ?? 0} · {formatSize(run.dataAddedPacked)} nuevos
    </span>
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

export function FileBackupsPanel({ clientId }: { clientId: string }) {
  const [repository, setRepository] = useState<FileBackupRepository | null | undefined>(undefined);
  const [runs, setRuns] = useState<FileBackupRun[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creatingRepo, setCreatingRepo] = useState(false);
  const [showRecoveryKey, setShowRecoveryKey] = useState<string | null>(null);
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
        setRuns(await fetchFileBackupRuns({ clientId, limit: 30 }));
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
      setShowRecoveryKey(await exportFileBackupRepositoryKey(repository.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
          Este cliente todavía no tiene un repositorio de backups de archivos. Se crea uno solo por cliente y se comparte
          entre todas sus tareas de archivos. También se crea automáticamente al agregar la primera tarea de archivos
          desde "Tareas".
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
        </div>
      </div>

      {(repository.lastPrunedAt || repository.lastCheckedAt) && (
        <p className="text-xs" style={{ color: 'var(--muted)' }}>
          {repository.lastPrunedAt && `Último prune: ${formatDateTime(repository.lastPrunedAt)}`}
          {repository.lastPrunedAt && repository.lastCheckedAt && ' · '}
          {repository.lastCheckedAt && `Último check: ${formatDateTime(repository.lastCheckedAt)}`}
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

      <div>
        <h3 className="mb-2 text-sm font-semibold">Snapshots</h3>
        {runs.length > 0 ? (
          <div className="overflow-x-auto rounded-xl border" style={{ borderColor: 'var(--border)' }}>
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="text-left" style={{ color: 'var(--muted)' }}>
                  <th className="px-4 py-2 font-medium">Fecha</th>
                  <th className="px-4 py-2 font-medium">Tarea</th>
                  <th className="px-4 py-2 font-medium">Estado</th>
                  <th className="px-4 py-2 font-medium">Nuevos/mod./elim.</th>
                  <th className="px-4 py-2 font-medium">Acciones</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id} style={{ borderTop: '1px solid var(--separator)' }}>
                    <td className="px-4 py-2.5">{formatDateTime(run.startedAt)}</td>
                    <td className="px-4 py-2.5" style={{ color: 'var(--muted)' }}>
                      {run.taskName ?? '—'}
                    </td>
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
        ) : (
          <p className="text-sm" style={{ color: 'var(--muted)' }}>
            Todavía no hay snapshots. Creá una tarea de archivos en "Tareas" y ejecutala.
          </p>
        )}
      </div>

      {showRecoveryKey && <RecoveryKeyModal recoveryKey={showRecoveryKey} onClose={() => setShowRecoveryKey(null)} />}
    </div>
  );
}
