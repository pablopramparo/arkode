import { Fragment, useState } from 'react';
import { Button } from '@heroui/react';
import type { ConnectionTestResult, DirectDumpCompatibilityResult } from 'engine-core';
import {
  deactivateTask,
  reactivateTask,
  taskExportUrl,
  type TaskRow,
} from '../lib/tasksClient';
import { runTaskNow, testTaskConnection, testTaskCompatibility } from '../lib/statusClient';
import {
  deactivateFileBackupTask,
  reactivateFileBackupTask,
  runFileBackupTaskNow,
  testFileBackupTaskConnection,
  type FileBackupTaskRow,
} from '../lib/fileBackupClient';
import { strategyLabel, isUnifiedTaskInProgress, type UnifiedTaskRow } from '../lib/unifiedTasks';
import { formatSchedule, formatConnectionTestVersions } from '../lib/format';
import { primaryPillStyle, dangerPillStyle } from '../lib/pillStyles';
import { IconButton, IconLinkButton } from './IconButton';
import { EditIcon, PlayIcon, PulseIcon, CheckCircleIcon, DownloadIcon } from './icons';
import { ClientLink } from './ClientLink';
import { BackupSetBadge } from './BackupSetBadge';
import { KindBadge } from './KindBadge';
import { Spinner } from './Spinner';
import { TaskEditModal } from './TaskEditModal';
import { FileTaskEditModal } from './FileTaskEditModal';

function StrategyBadge({ row }: { row: UnifiedTaskRow }) {
  return (
    <span
      className="rounded-full px-2 py-0.5 text-xs font-medium"
      style={{ backgroundColor: 'color-mix(in oklab, var(--accent) 15%, transparent)', color: 'var(--accent)' }}
    >
      {strategyLabel(row.strategy)}
    </span>
  );
}

interface RowActionState {
  busy?: 'run' | 'test' | 'compatibility' | 'toggle';
  testResult?: ConnectionTestResult;
  compatibilityResult?: DirectDumpCompatibilityResult;
  actionError?: string;
}

export function UnifiedTaskTable({
  rows,
  onChanged,
  onSelectClient,
  showClientColumn = true,
}: {
  rows: UnifiedTaskRow[];
  onChanged: () => void;
  onSelectClient?: (clientId: string) => void;
  showClientColumn?: boolean;
}) {
  const [actionState, setActionState] = useState<Record<string, RowActionState>>({});
  const [editing, setEditing] = useState<UnifiedTaskRow | null>(null);

  function patch(id: string, p: RowActionState) {
    setActionState((prev) => ({ ...prev, [id]: { ...prev[id], ...p } }));
  }

  async function handleRun(row: UnifiedTaskRow) {
    patch(row.id, { busy: 'run', actionError: undefined, testResult: undefined });
    try {
      await (row.kind === 'file' ? runFileBackupTaskNow(row.id) : runTaskNow(row.id));
      patch(row.id, { busy: undefined });
      onChanged();
    } catch (err) {
      patch(row.id, { busy: undefined, actionError: err instanceof Error ? err.message : String(err) });
    }
  }

  async function handleTest(row: UnifiedTaskRow, trustHost?: boolean) {
    patch(row.id, { busy: 'test', actionError: undefined, testResult: undefined, compatibilityResult: undefined });
    try {
      const result =
        row.kind === 'file'
          ? await testFileBackupTaskConnection(row.id, trustHost)
          : await testTaskConnection(row.id, trustHost);
      patch(row.id, { busy: undefined, testResult: result });
    } catch (err) {
      patch(row.id, { busy: undefined, actionError: err instanceof Error ? err.message : String(err) });
    }
  }

  async function handleTestCompatibility(row: UnifiedTaskRow) {
    patch(row.id, { busy: 'compatibility', actionError: undefined, testResult: undefined, compatibilityResult: undefined });
    try {
      const result = await testTaskCompatibility(row.id);
      patch(row.id, { busy: undefined, compatibilityResult: result });
    } catch (err) {
      patch(row.id, { busy: undefined, actionError: err instanceof Error ? err.message : String(err) });
    }
  }

  async function handleToggleActive(row: UnifiedTaskRow) {
    if (row.isActive && !window.confirm(`¿Desactivar "${row.name}"? Dejará de programarse; su historial no se toca.`)) return;
    patch(row.id, { busy: 'toggle', actionError: undefined });
    try {
      if (row.kind === 'file') {
        await (row.isActive ? deactivateFileBackupTask(row.id) : reactivateFileBackupTask(row.id));
      } else {
        await (row.isActive ? deactivateTask(row.id) : reactivateTask(row.id));
      }
      patch(row.id, { busy: undefined });
      onChanged();
    } catch (err) {
      patch(row.id, { busy: undefined, actionError: err instanceof Error ? err.message : String(err) });
    }
  }

  const colCount = showClientColumn ? 6 : 5;

  return (
    <>
      <div className="overflow-x-auto rounded-xl border" style={{ borderColor: 'var(--border)' }}>
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="text-left whitespace-nowrap" style={{ color: 'var(--muted)' }}>
              {showClientColumn && <th className="px-4 py-2 font-medium">Cliente</th>}
              <th className="px-4 py-2 font-medium">Nombre</th>
              <th className="px-4 py-2 font-medium">Tipo</th>
              <th className="px-4 py-2 font-medium">Origen</th>
              <th className="px-4 py-2 font-medium">Horario</th>
              <th className="px-4 py-2 font-medium">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const state = actionState[row.id];
              const hasDetail = Boolean(state?.testResult || state?.compatibilityResult || state?.actionError);
              const inProgress = isUnifiedTaskInProgress(row);
              const canTest = row.kind === 'db' || row.strategy === 'remote_folder';
              return (
                <Fragment key={`${row.kind}-${row.id}`}>
                  <tr
                    style={{
                      borderTop: '1px solid var(--separator)',
                      opacity: row.isActive ? 1 : 0.55,
                    }}
                  >
                    {showClientColumn && (
                      <td className="px-4 py-2.5 font-medium">
                        <ClientLink clientId={row.clientId} name={row.clientName} onSelect={onSelectClient ?? (() => {})} />
                      </td>
                    )}
                    <td className="whitespace-nowrap px-4 py-2.5">
                      {row.name}
                      {!row.isActive && (
                        <span className="ml-2 text-xs font-normal" style={{ color: 'var(--muted)' }}>
                          (inactiva)
                        </span>
                      )}
                      <KindBadge kind={row.kind} />
                      <BackupSetBadge name={row.backupSetName} />
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5">
                      <StrategyBadge row={row} />
                    </td>
                    <td className="min-w-44 px-4 py-2.5" style={{ color: 'var(--muted)' }}>
                      {row.originLabel}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5" style={{ color: 'var(--muted)' }}>
                      {formatSchedule(row)}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2 whitespace-nowrap">
                        {row.isActive && (
                          <>
                            <Button
                              size="sm"
                              className="rounded-full px-3"
                              style={primaryPillStyle}
                              isDisabled={Boolean(state?.busy) || inProgress}
                              onPress={() => handleRun(row)}
                            >
                              {state?.busy === 'run' || inProgress ? (
                                <span className="flex items-center gap-1.5">
                                  <Spinner />
                                  {inProgress && state?.busy !== 'run' ? 'En curso…' : 'Ejecutando…'}
                                </span>
                              ) : (
                                <span className="flex items-center gap-1.5">
                                  <PlayIcon className="h-3.5 w-3.5" />
                                  Ejecutar ahora
                                </span>
                              )}
                            </Button>
                            {canTest && (
                              <IconButton
                                icon={<PulseIcon />}
                                label={state?.busy === 'test' ? 'Probando conexión…' : 'Probar conexión'}
                                disabled={Boolean(state?.busy)}
                                onPress={() => handleTest(row)}
                              />
                            )}
                            {row.kind === 'db' && row.strategy === 'direct_dump' && (
                              <IconButton
                                icon={<CheckCircleIcon />}
                                label={state?.busy === 'compatibility' ? 'Probando compatibilidad…' : 'Probar compatibilidad (versión + herramienta)'}
                                disabled={Boolean(state?.busy)}
                                onPress={() => handleTestCompatibility(row)}
                              />
                            )}
                            <IconButton icon={<EditIcon />} label="Editar" onPress={() => setEditing(row)} />
                            {row.kind === 'db' && (
                              <IconLinkButton
                                icon={<DownloadIcon />}
                                label="Exportar (conexión + tarea, para adjuntar a otro cliente)"
                                href={taskExportUrl(row.id)}
                              />
                            )}
                          </>
                        )}
                        <Button
                          size="sm"
                          className="rounded-full px-3"
                          style={row.isActive ? dangerPillStyle : primaryPillStyle}
                          isDisabled={state?.busy === 'toggle'}
                          onPress={() => handleToggleActive(row)}
                        >
                          {state?.busy === 'toggle' ? '…' : row.isActive ? 'Desactivar' : 'Reactivar'}
                        </Button>
                      </div>
                    </td>
                  </tr>
                  {hasDetail && (
                    <tr style={{ backgroundColor: 'color-mix(in oklab, var(--muted) 8%, transparent)' }}>
                      <td colSpan={colCount} className="px-4 py-2 text-xs">
                        {state?.actionError && <span style={{ color: 'var(--danger)' }}>Error: {state.actionError}</span>}
                        {state?.testResult && !state.testResult.unknownHost && (
                          <span style={{ color: state.testResult.ok ? 'var(--success)' : 'var(--danger)' }}>
                            {state.testResult.ok ? 'Conexión OK' : 'Conexión fallida'}
                            {state.testResult.message ? ` — ${state.testResult.message}` : ''}
                            {state.testResult.latencyMs != null ? ` (${state.testResult.latencyMs} ms)` : ''}
                            {formatConnectionTestVersions(state.testResult)}
                          </span>
                        )}
                        {state?.testResult?.unknownHost && (
                          <div
                            className="flex flex-wrap items-center gap-2"
                            style={{ color: state.testResult.unknownHost.previousFingerprintSha256 ? 'var(--danger)' : 'var(--warning)' }}
                          >
                            <span>
                              {state.testResult.unknownHost.previousFingerprintSha256 ? (
                                <>
                                  ⚠ La clave del host cambió — ahora {state.testResult.unknownHost.fingerprintSha256}, antes{' '}
                                  {state.testResult.unknownHost.previousFingerprintSha256}. Confirmá con quien administra el
                                  servidor antes de confiar.
                                </>
                              ) : (
                                <>
                                  Host desconocido — {state.testResult.unknownHost.keyType} {state.testResult.unknownHost.fingerprintSha256}.
                                  ¿Confiás en este host?
                                </>
                              )}
                            </span>
                            <Button
                              size="sm"
                              className="rounded-full px-3"
                              style={primaryPillStyle}
                              isDisabled={state.busy === 'test'}
                              onPress={() => handleTest(row, true)}
                            >
                              Confiar y probar de nuevo
                            </Button>
                          </div>
                        )}
                        {state?.compatibilityResult && (
                          <span style={{ color: state.compatibilityResult.ok ? 'var(--success)' : 'var(--danger)' }}>
                            {state.compatibilityResult.ok ? 'Compatible' : 'No compatible'} — {state.compatibilityResult.message}
                            {formatConnectionTestVersions(state.compatibilityResult.connection)}
                          </span>
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

      {editing?.kind === 'db' && (
        <TaskEditModal
          task={editing.raw as TaskRow}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            onChanged();
          }}
        />
      )}
      {editing?.kind === 'file' && (
        <FileTaskEditModal
          task={editing.raw as FileBackupTaskRow}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            onChanged();
          }}
        />
      )}
    </>
  );
}
