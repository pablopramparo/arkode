import { Fragment, useCallback, useEffect, useState } from 'react';
import { Button } from '@heroui/react';
import { fetchDashboardStatus, runTaskNow, testTaskConnection, type ConnectionTestResult, type DashboardRow } from '../lib/statusClient';
import { formatAge, formatSize, ageInHours } from '../lib/format';
import { StatusChip } from './StatusChip';

const POLL_INTERVAL_MS = 20_000;
/** A daily backup task without a fresh file past this age is worth flagging, even if the last *attempt* technically succeeded a while ago. */
const STALE_THRESHOLD_HOURS = 26;

function isProblemRow(row: DashboardRow): boolean {
  if (row.status === 'Failed' || row.status === 'Warning' || row.status === 'NeverRun') return true;
  const hours = ageInHours(row.lastGoodBackupAt);
  return hours != null && hours > STALE_THRESHOLD_HOURS;
}

interface RowActionState {
  busy?: 'run' | 'test';
  testResult?: ConnectionTestResult;
  actionError?: string;
  errorExpanded?: boolean;
}

export function Dashboard() {
  const [rows, setRows] = useState<DashboardRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null);
  const [actionState, setActionState] = useState<Record<string, RowActionState>>({});

  const refresh = useCallback(async () => {
    try {
      const data = await fetchDashboardStatus();
      setRows(data);
      setError(null);
      setLastRefreshedAt(new Date());
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'No se pudo conectar con el motor de backups (¿está corriendo "engine-cli serve"?).'
      );
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [refresh]);

  function patchAction(taskId: string, patch: RowActionState) {
    setActionState((prev) => ({ ...prev, [taskId]: { ...prev[taskId], ...patch } }));
  }

  async function handleRun(taskId: string) {
    patchAction(taskId, { busy: 'run', actionError: undefined, testResult: undefined });
    try {
      await runTaskNow(taskId);
      patchAction(taskId, { busy: undefined });
      await refresh();
    } catch (err) {
      patchAction(taskId, { busy: undefined, actionError: err instanceof Error ? err.message : String(err) });
    }
  }

  async function handleTest(taskId: string) {
    patchAction(taskId, { busy: 'test', actionError: undefined, testResult: undefined });
    try {
      const result = await testTaskConnection(taskId);
      patchAction(taskId, { busy: undefined, testResult: result });
    } catch (err) {
      patchAction(taskId, { busy: undefined, actionError: err instanceof Error ? err.message : String(err) });
    }
  }

  function toggleError(taskId: string) {
    setActionState((prev) => ({
      ...prev,
      [taskId]: { ...prev[taskId], errorExpanded: !prev[taskId]?.errorExpanded },
    }));
  }

  const problemCount = rows?.filter(isProblemRow).length ?? 0;

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <header className="mb-6 flex items-baseline justify-between">
        <div>
          <h1 className="text-xl font-semibold">Codebius Backup Manager</h1>
          <p className="text-sm" style={{ color: 'var(--muted)' }}>
            {rows == null
              ? 'Cargando…'
              : problemCount > 0
                ? `${problemCount} de ${rows.length} tareas necesitan atención`
                : `${rows.length} tareas — todo en orden`}
          </p>
        </div>
        <Button size="sm" variant="secondary" onPress={refresh}>
          Actualizar
        </Button>
      </header>

      {error && (
        <div
          className="mb-4 rounded-md border px-4 py-3 text-sm"
          style={{ borderColor: 'var(--danger)', color: 'var(--danger)', backgroundColor: 'color-mix(in oklab, var(--danger) 10%, transparent)' }}
        >
          {error}
        </div>
      )}

      {rows && rows.length === 0 && !error && (
        <p style={{ color: 'var(--muted)' }}>No hay clientes con tareas configuradas todavía.</p>
      )}

      {rows && rows.length > 0 && (
        <div className="overflow-x-auto rounded-lg border" style={{ borderColor: 'var(--border)' }}>
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="text-left" style={{ color: 'var(--muted)' }}>
                <th className="px-4 py-2 font-medium">Cliente</th>
                <th className="px-4 py-2 font-medium">Tarea</th>
                <th className="px-4 py-2 font-medium">Último backup</th>
                <th className="px-4 py-2 font-medium">Tamaño</th>
                <th className="px-4 py-2 font-medium">Estado</th>
                <th className="px-4 py-2 font-medium">Antigüedad</th>
                <th className="px-4 py-2 font-medium">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const problem = isProblemRow(row);
                const state = actionState[row.taskId];
                const hasDetail = Boolean(state?.testResult || state?.actionError || (state?.errorExpanded && row.latestErrorMessage));
                return (
                  <Fragment key={row.taskId}>
                    <tr
                      style={{
                        borderTop: '1px solid var(--separator)',
                        borderLeft: problem ? '3px solid var(--danger)' : '3px solid transparent',
                        backgroundColor: problem ? 'color-mix(in oklab, var(--danger) 6%, transparent)' : undefined,
                      }}
                    >
                      <td className="px-4 py-2.5 font-medium">{row.client}</td>
                      <td className="px-4 py-2.5" style={{ color: 'var(--muted)' }}>
                        {row.task}
                      </td>
                      <td className="px-4 py-2.5">
                        {row.lastGoodBackupAt
                          ? new Date(row.lastGoodBackupAt).toLocaleString('es-AR', {
                              day: '2-digit',
                              month: '2-digit',
                              hour: '2-digit',
                              minute: '2-digit',
                            })
                          : '—'}
                      </td>
                      <td className="px-4 py-2.5">{formatSize(row.sizeBytes)}</td>
                      <td className="px-4 py-2.5">
                        <StatusChip status={row.status} />
                      </td>
                      <td className="px-4 py-2.5" style={{ color: problem ? 'var(--danger)' : undefined, fontWeight: problem ? 600 : undefined }}>
                        {formatAge(row.lastGoodBackupAt)}
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          <Button
                            size="sm"
                            variant="secondary"
                            isDisabled={Boolean(state?.busy)}
                            onPress={() => handleRun(row.taskId)}
                          >
                            {state?.busy === 'run' ? 'Ejecutando…' : 'Ejecutar ahora'}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            isDisabled={Boolean(state?.busy)}
                            onPress={() => handleTest(row.taskId)}
                          >
                            {state?.busy === 'test' ? 'Probando…' : 'Probar conexión'}
                          </Button>
                          {row.status === 'Failed' && row.latestErrorMessage && (
                            <Button size="sm" variant="ghost" onPress={() => toggleError(row.taskId)}>
                              {state?.errorExpanded ? 'Ocultar error' : 'Ver error'}
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                    {hasDetail && (
                      <tr style={{ backgroundColor: 'color-mix(in oklab, var(--muted) 8%, transparent)' }}>
                        <td colSpan={7} className="px-4 py-2 text-xs">
                          {state?.actionError && <span style={{ color: 'var(--danger)' }}>Error: {state.actionError}</span>}
                          {state?.testResult && (
                            <span style={{ color: state.testResult.ok ? 'var(--success)' : 'var(--danger)' }}>
                              {state.testResult.ok ? 'Conexión OK' : 'Conexión fallida'}
                              {state.testResult.message ? ` — ${state.testResult.message}` : ''}
                              {state.testResult.latencyMs != null ? ` (${state.testResult.latencyMs} ms)` : ''}
                            </span>
                          )}
                          {!state?.actionError && !state?.testResult && state?.errorExpanded && row.latestErrorMessage && (
                            <span style={{ color: 'var(--danger)', fontFamily: 'monospace' }}>{row.latestErrorMessage}</span>
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
      )}

      {lastRefreshedAt && (
        <p className="mt-4 text-xs" style={{ color: 'var(--muted)' }}>
          Actualizado {lastRefreshedAt.toLocaleTimeString('es-AR')}
        </p>
      )}
    </div>
  );
}
