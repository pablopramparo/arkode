import { Fragment, useCallback, useEffect, useState } from 'react';
import { Button } from '@heroui/react';
import { fetchDashboardStatus, runTaskNow, testTaskConnection, type ConnectionTestResult, type DashboardRow } from '../lib/statusClient';
import { runFileBackupTaskNow, testFileBackupTaskConnection, fetchFileBackupRuns } from '../lib/fileBackupClient';
import { fetchRuns } from '../lib/runsClient';
import { mergeRuns, type UnifiedRunRow } from '../lib/unifiedRuns';
import { IN_PROGRESS_RUN_STATUSES } from '../lib/tasksClient';
import { KindBadge } from './KindBadge';
import { formatAge, formatSize, ageInHours, formatConnectionTestVersions, formatDateTime, formatDuration } from '../lib/format';
import { StatusChip } from './StatusChip';
import { StatCard } from './StatCard';
import { ProgressBar } from './ProgressBar';
import { isLiveProgress } from '../lib/progress';
import { isInterruptedRun, friendlyRunError } from '../lib/runStatus';
import { ClientFilter, distinctClients } from './ClientFilter';
import { AlertTriangleIcon, CheckCircleIcon, ClipboardIcon, ClockIcon, EyeIcon, PlayIcon, PulseIcon, UsersIcon } from './icons';
import { primaryPillStyle } from '../lib/pillStyles';
import { IconButton } from './IconButton';
import { ClientLink } from './ClientLink';
import { Spinner } from './Spinner';
import { BackupSetBadge } from './BackupSetBadge';
import { SchedulerStatusBanner } from './SchedulerStatusBanner';
import { InstallHealthBanner } from './InstallHealthBanner';

const POLL_INTERVAL_MS = 20_000;
/** A daily backup task without a fresh file past this age is worth flagging, even if the last *attempt* technically succeeded a while ago. */
const STALE_THRESHOLD_HOURS = 26;
/** "Backups exitosos" on the stat row counts a Success attempt within this window — otherwise a months-old Success would inflate the count meaninglessly. */
const RECENT_SUCCESS_HOURS = 24;
/** "Actividad reciente" is operational context only — a short glance at what just ran, not a replacement for Logs or the client's Historial. */
const RECENT_ACTIVITY_LIMIT = 15;
/** "Próximos backups" is a peek at what's coming, not a full agenda. */
const UPCOMING_LIMIT = 8;

function isProblemRow(row: DashboardRow): boolean {
  // An interrupted run (update / reboot / power cut) isn't a backup failure —
  // only flag it if the last *good* backup is also missing or stale.
  if (isInterruptedRun(row.status, row.latestErrorMessage)) {
    const hours = ageInHours(row.lastGoodBackupAt);
    return hours == null || hours > STALE_THRESHOLD_HOURS;
  }
  if (row.status === 'Failed' || row.status === 'Warning' || row.status === 'NeverRun') return true;
  const hours = ageInHours(row.lastGoodBackupAt);
  return hours != null && hours > STALE_THRESHOLD_HOURS;
}

/** Order the "Necesita atención" list: hard failures first, then warnings, then never-run, then merely-stale. */
function attentionRank(row: DashboardRow): number {
  if (row.status === 'Failed') return 0;
  if (row.status === 'Warning') return 1;
  if (row.status === 'NeverRun') return 2;
  return 3;
}

/**
 * Whether the row's latest attempt is genuinely still going, per its own
 * last-known status — see the same doc comment on isTaskInProgress in
 * Tareas.tsx for why this is a UX nicety, not the real concurrency guard.
 */
function isRowInProgress(row: DashboardRow): boolean {
  return (IN_PROGRESS_RUN_STATUSES as string[]).includes(row.status);
}

/** A compact "in ~X" for an upcoming scheduled run. Absolute time is shown alongside it. */
function formatUntil(iso: string, now: Date = new Date()): string {
  const ms = new Date(iso).getTime() - now.getTime();
  if (ms <= 0) return 'pronto';
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `en ${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `en ${hours} h`;
  return `en ${Math.round(hours / 24)} d`;
}

interface RowActionState {
  busy?: 'run' | 'test';
  testResult?: ConnectionTestResult;
  actionError?: string;
  errorExpanded?: boolean;
}

interface ClientSummary {
  clientId: string;
  client: string;
  total: number;
  okCount: number;
  hasProblem: boolean;
  lastGoodBackupAt: string | null;
}

export function Dashboard({ onSelectClient }: { onSelectClient: (clientId: string) => void }) {
  const [rows, setRows] = useState<DashboardRow[] | null>(null);
  const [recentRuns, setRecentRuns] = useState<UnifiedRunRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null);
  const [actionState, setActionState] = useState<Record<string, RowActionState>>({});
  const [clientFilter, setClientFilter] = useState('');

  const refresh = useCallback(async () => {
    try {
      const [data, dbRuns, fileRuns] = await Promise.all([
        fetchDashboardStatus(),
        fetchRuns({ limit: RECENT_ACTIVITY_LIMIT }),
        fetchFileBackupRuns({ limit: RECENT_ACTIVITY_LIMIT }),
      ]);
      setRows(data);
      setRecentRuns(mergeRuns(dbRuns, fileRuns).slice(0, RECENT_ACTIVITY_LIMIT));
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

  // Poll faster while a run is actively reporting progress so the bar moves.
  const hasLiveRun = (rows ?? []).some((r) => isLiveProgress(r.status, r.progress));
  useEffect(() => {
    if (!hasLiveRun) return;
    const id = setInterval(refresh, 3000);
    return () => clearInterval(id);
  }, [hasLiveRun, refresh]);

  function patchAction(taskId: string, patch: RowActionState) {
    setActionState((prev) => ({ ...prev, [taskId]: { ...prev[taskId], ...patch } }));
  }

  async function handleRun(row: DashboardRow) {
    patchAction(row.taskId, { busy: 'run', actionError: undefined, testResult: undefined });
    try {
      await (row.kind === 'file' ? runFileBackupTaskNow(row.taskId) : runTaskNow(row.taskId));
      patchAction(row.taskId, { busy: undefined });
      await refresh();
    } catch (err) {
      patchAction(row.taskId, { busy: undefined, actionError: err instanceof Error ? err.message : String(err) });
    }
  }

  async function handleTest(row: DashboardRow, trustHost?: boolean) {
    patchAction(row.taskId, { busy: 'test', actionError: undefined, testResult: undefined });
    try {
      const result =
        row.kind === 'file'
          ? await testFileBackupTaskConnection(row.taskId, trustHost)
          : await testTaskConnection(row.taskId, trustHost);
      patchAction(row.taskId, { busy: undefined, testResult: result });
    } catch (err) {
      patchAction(row.taskId, { busy: undefined, actionError: err instanceof Error ? err.message : String(err) });
    }
  }

  function toggleError(taskId: string) {
    setActionState((prev) => ({
      ...prev,
      [taskId]: { ...prev[taskId], errorExpanded: !prev[taskId]?.errorExpanded },
    }));
  }

  const clientOptions = distinctClients(rows, (r) => r.clientId, (r) => r.client);
  const visibleRows = rows && clientFilter ? rows.filter((r) => r.clientId === clientFilter) : rows;
  const visibleRecent = recentRuns && clientFilter ? recentRuns.filter((r) => r.clientId === clientFilter) : recentRuns;

  const problemCount = visibleRows?.filter(isProblemRow).length ?? 0;
  const clientCount = visibleRows ? new Set(visibleRows.map((r) => r.clientId)).size : 0;
  const recentSuccessCount =
    visibleRows?.filter((r) => r.status === 'Success' && (ageInHours(r.latestAttemptAt) ?? Infinity) <= RECENT_SUCCESS_HOURS)
      .length ?? 0;

  const attentionRows = (visibleRows ?? [])
    .filter(isProblemRow)
    .sort((a, b) => attentionRank(a) - attentionRank(b) || a.client.localeCompare(b.client));

  const upcomingRows = (visibleRows ?? [])
    .filter((r) => r.nextRunAt)
    .sort((a, b) => a.nextRunAt!.localeCompare(b.nextRunAt!))
    .slice(0, UPCOMING_LIMIT);

  const clientSummaries: ClientSummary[] = (() => {
    const map = new Map<string, ClientSummary>();
    for (const row of visibleRows ?? []) {
      let s = map.get(row.clientId);
      if (!s) {
        s = { clientId: row.clientId, client: row.client, total: 0, okCount: 0, hasProblem: false, lastGoodBackupAt: null };
        map.set(row.clientId, s);
      }
      s.total += 1;
      if (isProblemRow(row)) s.hasProblem = true;
      else s.okCount += 1;
      if (row.lastGoodBackupAt && (!s.lastGoodBackupAt || row.lastGoodBackupAt > s.lastGoodBackupAt)) {
        s.lastGoodBackupAt = row.lastGoodBackupAt;
      }
    }
    return [...map.values()].sort(
      (a, b) => Number(b.hasProblem) - Number(a.hasProblem) || a.client.localeCompare(b.client)
    );
  })();

  /** The Ejecutar / Probar / Ver error controls — identical in the "Necesita atención" callout and the full task table below. */
  function renderRowActions(row: DashboardRow) {
    const state = actionState[row.taskId];
    return (
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          className="rounded-full px-3"
          style={primaryPillStyle}
          isDisabled={Boolean(state?.busy) || isRowInProgress(row)}
          onPress={() => handleRun(row)}
        >
          {state?.busy === 'run' || isRowInProgress(row) ? (
            <span className="flex items-center gap-1.5">
              <Spinner />
              {isRowInProgress(row) && state?.busy !== 'run' ? 'En curso…' : 'Ejecutando…'}
            </span>
          ) : (
            <span className="flex items-center gap-1.5">
              <PlayIcon className="h-3.5 w-3.5" />
              Ejecutar ahora
            </span>
          )}
        </Button>
        {(row.kind === 'db' || row.strategy === 'remote_folder') && (
          <IconButton
            icon={<PulseIcon />}
            label={state?.busy === 'test' ? 'Probando conexión…' : 'Probar conexión'}
            disabled={Boolean(state?.busy)}
            onPress={() => handleTest(row)}
          />
        )}
        {row.status === 'Failed' && row.latestErrorMessage && (
          <IconButton
            icon={<EyeIcon />}
            label={
              state?.errorExpanded
                ? 'Ocultar detalle'
                : isInterruptedRun(row.status, row.latestErrorMessage)
                  ? 'Ver detalle'
                  : 'Ver error'
            }
            onPress={() => toggleError(row.taskId)}
          />
        )}
      </div>
    );
  }

  function renderProgressRow(row: DashboardRow, colSpan: number) {
    if (!isLiveProgress(row.status, row.progress)) return null;
    return (
      <tr>
        <td colSpan={colSpan} className="px-4 pb-2">
          <ProgressBar progress={row.progress} />
        </td>
      </tr>
    );
  }

  function renderDetailRow(row: DashboardRow, colSpan: number) {
    const state = actionState[row.taskId];
    const hasDetail = Boolean(
      state?.testResult || state?.actionError || (state?.errorExpanded && row.latestErrorMessage)
    );
    if (!hasDetail) return null;
    return (
      <tr style={{ backgroundColor: 'color-mix(in oklab, var(--muted) 8%, transparent)' }}>
        <td colSpan={colSpan} className="px-4 py-2 text-xs">
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
                    {state.testResult.unknownHost.previousFingerprintSha256}. Confirmá con quien administra el servidor antes de
                    confiar.
                  </>
                ) : (
                  <>
                    Host desconocido — {state.testResult.unknownHost.keyType} {state.testResult.unknownHost.fingerprintSha256}. ¿Confiás
                    en este host?
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
          {!state?.actionError && !state?.testResult && state?.errorExpanded && row.latestErrorMessage && (
            <span
              style={{
                color: isInterruptedRun(row.status, row.latestErrorMessage) ? 'var(--muted)' : 'var(--danger)',
                fontFamily: isInterruptedRun(row.status, row.latestErrorMessage) ? undefined : 'monospace',
              }}
            >
              {friendlyRunError(row.status, row.latestErrorMessage)}
            </span>
          )}
        </td>
      </tr>
    );
  }

  return (
    <div className="max-w-[1600px] px-10 py-8">
      <header className="mb-6 flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Dashboard</h1>
          <p className="text-sm" style={{ color: 'var(--muted)' }}>
            Resumen general de tus backups
          </p>
        </div>
        <div className="flex items-center gap-3">
          <ClientFilter clients={clientOptions} value={clientFilter} onChange={setClientFilter} />
          <Button size="sm" className="rounded-full px-4" style={primaryPillStyle} onPress={refresh}>
            Actualizar
          </Button>
        </div>
      </header>

      <InstallHealthBanner />
      <SchedulerStatusBanner />

      {visibleRows && (
        <div className="mb-6 grid grid-cols-4 gap-4">
          <StatCard icon={<UsersIcon />} value={clientCount} label="Clientes activos" color="blue" />
          <StatCard icon={<ClipboardIcon />} value={visibleRows.length} label="Tareas" sublabel="en total" color="purple" />
          <StatCard
            icon={<CheckCircleIcon />}
            value={recentSuccessCount}
            label="Backups exitosos"
            sublabel="últimas 24 h"
            color="green"
            alert={visibleRows.length > 0 && recentSuccessCount === 0}
          />
          <StatCard
            icon={<AlertTriangleIcon />}
            value={problemCount}
            label="Con errores"
            sublabel={problemCount > 0 ? 'requiere atención' : undefined}
            color="red"
            alert={problemCount > 0}
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

      {visibleRows && visibleRows.length === 0 && !error && (
        <p style={{ color: 'var(--muted)' }}>No hay clientes con tareas configuradas todavía.</p>
      )}

      {/* ── Necesita atención ─────────────────────────────────────────── */}
      {attentionRows.length > 0 && (
        <div
          className="mb-6 rounded-xl border"
          style={{ borderColor: 'var(--danger)', backgroundColor: 'color-mix(in oklab, var(--danger) 5%, transparent)' }}
        >
          <div className="flex items-center gap-2 border-b px-4 py-3" style={{ borderColor: 'var(--border)' }}>
            <AlertTriangleIcon className="h-4 w-4" />
            <div>
              <div className="text-sm font-semibold">Necesita atención</div>
              <div className="text-xs" style={{ color: 'var(--muted)' }}>
                {attentionRows.length} {attentionRows.length === 1 ? 'tarea' : 'tareas'} con errores o backups atrasados
              </div>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="text-left" style={{ color: 'var(--muted)' }}>
                  <th className="px-4 py-2 font-medium">Cliente</th>
                  <th className="px-4 py-2 font-medium">Tarea</th>
                  <th className="px-4 py-2 font-medium">Estado</th>
                  <th className="px-4 py-2 font-medium">Último backup bueno</th>
                  <th className="px-4 py-2 font-medium">Acciones</th>
                </tr>
              </thead>
              <tbody>
                {attentionRows.map((row) => (
                  <Fragment key={row.taskId}>
                    <tr style={{ borderTop: '1px solid var(--separator)', borderLeft: '3px solid var(--danger)' }}>
                      <td className="px-4 py-2.5 font-medium">
                        <ClientLink clientId={row.clientId} name={row.client} onSelect={onSelectClient} />
                      </td>
                      <td className="px-4 py-2.5" style={{ color: 'var(--muted)' }}>
                        {row.task}
                        <KindBadge kind={row.kind} />
                        <BackupSetBadge name={row.backupSetName} />
                      </td>
                      <td className="px-4 py-2.5">
                        <StatusChip status={row.status} errorMessage={row.latestErrorMessage} />
                      </td>
                      <td className="px-4 py-2.5" style={{ color: 'var(--danger)', fontWeight: 600 }}>
                        {row.lastGoodBackupAt ? formatAge(row.lastGoodBackupAt) : 'nunca'}
                      </td>
                      <td className="px-4 py-2.5">{renderRowActions(row)}</td>
                    </tr>
                    {renderProgressRow(row, 5)}
                    {renderDetailRow(row, 5)}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Estado por cliente · Próximos backups ─────────────────────── */}
      {visibleRows && visibleRows.length > 0 && (
        <div className="mb-6 grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl border" style={{ borderColor: 'var(--border)' }}>
            <div className="border-b px-4 py-3" style={{ borderColor: 'var(--border)' }}>
              <div className="text-sm font-semibold">Estado por cliente</div>
              <div className="text-xs" style={{ color: 'var(--muted)' }}>
                {clientSummaries.length} {clientSummaries.length === 1 ? 'cliente' : 'clientes'}
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="text-left" style={{ color: 'var(--muted)' }}>
                    <th className="px-4 py-2 font-medium">Cliente</th>
                    <th className="px-4 py-2 font-medium">Tareas OK</th>
                    <th className="px-4 py-2 font-medium">Último backup</th>
                  </tr>
                </thead>
                <tbody>
                  {clientSummaries.map((s) => (
                    <tr
                      key={s.clientId}
                      style={{
                        borderTop: '1px solid var(--separator)',
                        borderLeft: s.hasProblem ? '3px solid var(--danger)' : '3px solid transparent',
                      }}
                    >
                      <td className="px-4 py-2.5 font-medium">
                        <ClientLink clientId={s.clientId} name={s.client} onSelect={onSelectClient} />
                      </td>
                      <td
                        className="px-4 py-2.5"
                        style={{ color: s.hasProblem ? 'var(--danger)' : 'var(--success)', fontWeight: 600 }}
                      >
                        {s.okCount}/{s.total}
                      </td>
                      <td className="px-4 py-2.5" style={{ color: 'var(--muted)' }}>
                        {s.lastGoodBackupAt ? formatAge(s.lastGoodBackupAt) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="rounded-xl border" style={{ borderColor: 'var(--border)' }}>
            <div className="flex items-center gap-2 border-b px-4 py-3" style={{ borderColor: 'var(--border)' }}>
              <ClockIcon className="h-4 w-4" />
              <div>
                <div className="text-sm font-semibold">Próximos backups</div>
                <div className="text-xs" style={{ color: 'var(--muted)' }}>
                  Según el horario configurado de cada tarea
                </div>
              </div>
            </div>
            {upcomingRows.length === 0 ? (
              <p className="px-4 py-3 text-sm" style={{ color: 'var(--muted)' }}>
                Ninguna tarea con horario activo.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="text-left" style={{ color: 'var(--muted)' }}>
                      <th className="px-4 py-2 font-medium">Cliente</th>
                      <th className="px-4 py-2 font-medium">Tarea</th>
                      <th className="px-4 py-2 font-medium">Cuándo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {upcomingRows.map((row) => (
                      <tr key={row.taskId} style={{ borderTop: '1px solid var(--separator)' }}>
                        <td className="px-4 py-2.5 font-medium">
                          <ClientLink clientId={row.clientId} name={row.client} onSelect={onSelectClient} />
                        </td>
                        <td className="px-4 py-2.5" style={{ color: 'var(--muted)' }}>
                          {row.task}
                          <KindBadge kind={row.kind} />
                        </td>
                        <td className="px-4 py-2.5">
                          {formatDateTime(row.nextRunAt)}
                          <span className="ml-2 text-xs" style={{ color: 'var(--muted)' }}>
                            {formatUntil(row.nextRunAt!)}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Actividad reciente ───────────────────────────────────────── */}
      {visibleRecent && visibleRecent.length > 0 && (
        <div className="mb-6 rounded-xl border" style={{ borderColor: 'var(--border)' }}>
          <div className="border-b px-4 py-3" style={{ borderColor: 'var(--border)' }}>
            <div className="text-sm font-semibold">Actividad reciente</div>
            <div className="text-xs" style={{ color: 'var(--muted)' }}>
              Últimas corridas — contexto operativo, no reemplaza Logs ni el historial del cliente
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="text-left" style={{ color: 'var(--muted)' }}>
                  <th className="px-4 py-2 font-medium">Cliente</th>
                  <th className="px-4 py-2 font-medium">Tarea</th>
                  <th className="px-4 py-2 font-medium">Estado</th>
                  <th className="px-4 py-2 font-medium">Cuándo</th>
                  <th className="px-4 py-2 font-medium">Duración</th>
                </tr>
              </thead>
              <tbody>
                {visibleRecent.map((run) => (
                  <tr key={`${run.kind}-${run.id}`} style={{ borderTop: '1px solid var(--separator)' }}>
                    <td className="px-4 py-2 font-medium">
                      {run.clientId ? (
                        <ClientLink clientId={run.clientId} name={run.clientName ?? '—'} onSelect={onSelectClient} />
                      ) : (
                        run.clientName ?? '—'
                      )}
                    </td>
                    <td className="px-4 py-2" style={{ color: 'var(--muted)' }}>
                      {run.taskName ?? '—'}
                      <KindBadge kind={run.kind} />
                    </td>
                    <td className="px-4 py-2">
                      <StatusChip status={run.status} errorMessage={run.errorMessage} />
                    </td>
                    <td className="px-4 py-2" style={{ color: 'var(--muted)' }}>
                      {formatDateTime(run.startedAt)}
                    </td>
                    <td className="px-4 py-2" style={{ color: 'var(--muted)' }}>
                      {formatDuration(run.durationMs)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Estado de tareas (tabla global, siempre visible) ──────────── */}
      {visibleRows && visibleRows.length > 0 && (
        <div className="rounded-xl border" style={{ borderColor: 'var(--border)' }}>
          <div className="border-b px-4 py-3" style={{ borderColor: 'var(--border)' }}>
            <div className="text-sm font-semibold">Estado de tareas</div>
            <div className="text-xs" style={{ color: 'var(--muted)' }}>
              {problemCount > 0 ? `${problemCount} de ${visibleRows.length} tareas necesitan atención` : 'Todo en orden'}
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
                {visibleRows.map((row) => {
                  const problem = isProblemRow(row);
                  return (
                    <Fragment key={row.taskId}>
                      <tr
                        style={{
                          borderTop: '1px solid var(--separator)',
                          borderLeft: problem ? '3px solid var(--danger)' : '3px solid transparent',
                          backgroundColor: problem ? 'color-mix(in oklab, var(--danger) 6%, transparent)' : undefined,
                        }}
                      >
                        <td className="px-4 py-2.5 font-medium">
                          <ClientLink clientId={row.clientId} name={row.client} onSelect={onSelectClient} />
                        </td>
                        <td className="px-4 py-2.5" style={{ color: 'var(--muted)' }}>
                          {row.task}
                          <KindBadge kind={row.kind} />
                          <BackupSetBadge name={row.backupSetName} />
                        </td>
                        <td className="px-4 py-2.5">{formatDateTime(row.lastGoodBackupAt)}</td>
                        <td className="px-4 py-2.5">{formatSize(row.sizeBytes)}</td>
                        <td className="px-4 py-2.5">
                          <StatusChip status={row.status} errorMessage={row.latestErrorMessage} />
                        </td>
                        <td
                          className="px-4 py-2.5"
                          style={{ color: problem ? 'var(--danger)' : undefined, fontWeight: problem ? 600 : undefined }}
                        >
                          {formatAge(row.lastGoodBackupAt)}
                        </td>
                        <td className="px-4 py-2.5">{renderRowActions(row)}</td>
                      </tr>
                      {renderProgressRow(row, 7)}
                      {renderDetailRow(row, 7)}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          {lastRefreshedAt && (
            <div className="border-t px-4 py-2 text-xs" style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}>
              Actualizado {lastRefreshedAt.toLocaleTimeString('es-AR', { hour12: false })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
