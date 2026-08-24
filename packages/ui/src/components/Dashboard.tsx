import { Fragment, useCallback, useEffect, useState } from 'react';
import { Button } from '@heroui/react';
import { fetchDashboardStatus, runTaskNow, testTaskConnection, type ConnectionTestResult, type DashboardRow } from '../lib/statusClient';
import { formatAge, formatSize, ageInHours } from '../lib/format';
import { StatusChip } from './StatusChip';
import { StatCard } from './StatCard';
import { AlertTriangleIcon, CheckCircleIcon, ClipboardIcon, UsersIcon } from './icons';

const POLL_INTERVAL_MS = 20_000;
/** A daily backup task without a fresh file past this age is worth flagging, even if the last *attempt* technically succeeded a while ago. */
const STALE_THRESHOLD_HOURS = 26;
/** "Backups exitosos" on the stat row counts a Success attempt within this window — otherwise a months-old Success would inflate the count meaninglessly. */
const RECENT_SUCCESS_HOURS = 24;

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

const primaryPillStyle: React.CSSProperties = {
  background: 'linear-gradient(135deg, #3b82f6, #6366f1)',
  color: 'white',
  border: 0,
};

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
  const distinctClients = rows ? new Set(rows.map((r) => r.clientId)).size : 0;
  const recentSuccessCount =
    rows?.filter((r) => r.status === 'Success' && (ageInHours(r.latestAttemptAt) ?? Infinity) <= RECENT_SUCCESS_HOURS)
      .length ?? 0;

  return (
    <div className="mx-auto max-w-6xl px-8 py-8">
      <header className="mb-6 flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold">¡Hola, Codebius!</h1>
          <p className="text-sm" style={{ color: 'var(--muted)' }}>
            Resumen general de tus backups
          </p>
        </div>
        <Button size="sm" className="rounded-full px-4" style={primaryPillStyle} onPress={refresh}>
          Actualizar
        </Button>
      </header>

      {rows && (
        <div className="mb-6 grid grid-cols-4 gap-4">
          <StatCard icon={<UsersIcon />} value={distinctClients} label="Clientes activos" color="blue" />
          <StatCard icon={<ClipboardIcon />} value={rows.length} label="Tareas" sublabel="en total" color="purple" />
          <StatCard
            icon={<CheckCircleIcon />}
            value={recentSuccessCount}
            label="Backups exitosos"
            sublabel="últimas 24 h"
            color="green"
          />
          <StatCard
            icon={<AlertTriangleIcon />}
            value={problemCount}
            label="Con errores"
            sublabel={problemCount > 0 ? 'requiere atención' : undefined}
            color="red"
          />
        </div>
      )}

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
        <div className="rounded-xl border" style={{ borderColor: 'var(--border)' }}>
          <div className="border-b px-4 py-3" style={{ borderColor: 'var(--border)' }}>
            <div className="text-sm font-semibold">Estado de tareas</div>
            <div className="text-xs" style={{ color: 'var(--muted)' }}>
              {problemCount > 0 ? `${problemCount} de ${rows.length} tareas necesitan atención` : 'Todo en orden'}
            </div>
          </div>
          <div className="overflow-x-auto">
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
                  const hasDetail = Boolean(
                    state?.testResult || state?.actionError || (state?.errorExpanded && row.latestErrorMessage)
                  );
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
                        <td
                          className="px-4 py-2.5"
                          style={{ color: problem ? 'var(--danger)' : undefined, fontWeight: problem ? 600 : undefined }}
                        >
                          {formatAge(row.lastGoodBackupAt)}
                        </td>
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-2">
                            <Button
                              size="sm"
                              className="rounded-full px-3"
                              style={primaryPillStyle}
                              isDisabled={Boolean(state?.busy)}
                              onPress={() => handleRun(row.taskId)}
                            >
                              {state?.busy === 'run' ? 'Ejecutando…' : 'Ejecutar ahora'}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="rounded-full px-3"
                              isDisabled={Boolean(state?.busy)}
                              onPress={() => handleTest(row.taskId)}
                            >
                              {state?.busy === 'test' ? 'Probando…' : 'Probar conexión'}
                            </Button>
                            {row.status === 'Failed' && row.latestErrorMessage && (
                              <Button size="sm" variant="ghost" className="rounded-full px-3" onPress={() => toggleError(row.taskId)}>
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
          {lastRefreshedAt && (
            <div className="border-t px-4 py-2 text-xs" style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}>
              Actualizado {lastRefreshedAt.toLocaleTimeString('es-AR')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
