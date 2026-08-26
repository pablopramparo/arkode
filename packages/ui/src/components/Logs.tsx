import { useCallback, useEffect, useState } from 'react';
import { Button } from '@heroui/react';
import type { LogEventLevel } from 'engine-core';
import { fetchLogs, type LogEventRow } from '../lib/logsClient';
import { fetchFileLogs } from '../lib/fileBackupClient';
import { formatDateTime } from '../lib/format';
import { ClientLink } from './ClientLink';
import { primaryPillStyle } from '../lib/pillStyles';

type Domain = 'database' | 'files';

const PAGE_SIZE = 50;

const LEVEL_COLOR: Record<LogEventLevel, string> = {
  debug: 'var(--muted)',
  info: 'var(--accent)',
  warn: 'var(--warning)',
  error: 'var(--danger)',
};

function LevelBadge({ level }: { level: LogEventLevel }) {
  const color = LEVEL_COLOR[level];
  return (
    <span
      className="rounded-full px-2 py-0.5 text-xs font-medium uppercase"
      style={{ backgroundColor: `color-mix(in oklab, ${color} 15%, transparent)`, color }}
    >
      {level}
    </span>
  );
}

const inputStyle: React.CSSProperties = {
  backgroundColor: 'var(--background)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  padding: '6px 10px',
  color: 'var(--foreground)',
};

export function Logs({ onSelectClient }: { onSelectClient: (clientId: string) => void }) {
  const [domain, setDomain] = useState<Domain>('database');
  const [events, setEvents] = useState<LogEventRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [steps, setSteps] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [step, setStep] = useState('');
  const [level, setLevel] = useState<LogEventLevel | ''>('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const fetcher = domain === 'database' ? fetchLogs : fetchFileLogs;
      const result = await fetcher({
        search: search.trim() || undefined,
        step: step || undefined,
        level: level || undefined,
        from: from ? `${from}T00:00:00.000Z` : undefined,
        to: to ? `${to}T23:59:59.999Z` : undefined,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      });
      setEvents(result.events);
      setTotal(result.total);
      setSteps(result.steps);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo conectar con el motor de backups.');
    }
  }, [domain, search, step, level, from, to, page]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Any filter (or domain) change should reset back to page 0 — otherwise a narrower filter can land on an empty page past the new total.
  function updateFilter(setter: () => void) {
    setter();
    setPage(0);
  }

  function switchDomain(next: Domain) {
    if (next === domain) return;
    setDomain(next);
    setStep(''); // steps are domain-specific (produce/validate/... differ from connect/download/...) — a stale filter from the other domain would just show zero results
    setPage(0);
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="max-w-[1600px] px-10 py-8">
      <header className="mb-6 flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Logs</h1>
          <p className="text-sm" style={{ color: 'var(--muted)' }}>
            {events == null ? 'Cargando…' : `${total} evento${total === 1 ? '' : 's'}`}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex gap-1 rounded-full border p-0.5" style={{ borderColor: 'var(--border)' }}>
            <button
              type="button"
              className="rounded-full px-3 py-1 text-xs font-medium"
              style={domain === 'database' ? primaryPillStyle : { color: 'var(--muted)' }}
              onClick={() => switchDomain('database')}
            >
              Base de datos
            </button>
            <button
              type="button"
              className="rounded-full px-3 py-1 text-xs font-medium"
              style={domain === 'files' ? primaryPillStyle : { color: 'var(--muted)' }}
              onClick={() => switchDomain('files')}
            >
              Archivos
            </button>
          </div>
          <Button size="sm" variant="ghost" className="rounded-full px-4" onPress={refresh}>
            Actualizar
          </Button>
        </div>
      </header>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input
          style={{ ...inputStyle, minWidth: 220 }}
          placeholder="Buscar en el mensaje…"
          value={search}
          onChange={(e) => updateFilter(() => setSearch(e.target.value))}
        />
        <select style={inputStyle} value={step} onChange={(e) => updateFilter(() => setStep(e.target.value))}>
          <option value="">Todas las acciones</option>
          {steps.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select
          style={inputStyle}
          value={level}
          onChange={(e) => updateFilter(() => setLevel(e.target.value as LogEventLevel | ''))}
        >
          <option value="">Todos los niveles</option>
          <option value="debug">Debug</option>
          <option value="info">Info</option>
          <option value="warn">Warn</option>
          <option value="error">Error</option>
        </select>
        <input type="date" style={inputStyle} value={from} onChange={(e) => updateFilter(() => setFrom(e.target.value))} />
        <span style={{ color: 'var(--muted)' }}>a</span>
        <input type="date" style={inputStyle} value={to} onChange={(e) => updateFilter(() => setTo(e.target.value))} />
      </div>

      {error && (
        <div
          className="mb-4 rounded-md border px-4 py-3 text-sm"
          style={{ borderColor: 'var(--danger)', color: 'var(--danger)', backgroundColor: 'color-mix(in oklab, var(--danger) 10%, transparent)' }}
        >
          {error}
        </div>
      )}

      {events && events.length === 0 && !error && (
        <p style={{ color: 'var(--muted)' }}>No hay eventos que coincidan con estos filtros.</p>
      )}

      {events && events.length > 0 && (
        <div className="rounded-xl border" style={{ borderColor: 'var(--border)' }}>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="text-left" style={{ color: 'var(--muted)' }}>
                  <th className="px-4 py-2 font-medium">Fecha</th>
                  <th className="px-4 py-2 font-medium">Cliente</th>
                  <th className="px-4 py-2 font-medium">Tarea</th>
                  <th className="px-4 py-2 font-medium">Acción</th>
                  <th className="px-4 py-2 font-medium">Nivel</th>
                  <th className="px-4 py-2 font-medium">Mensaje</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <tr key={event.id} style={{ borderTop: '1px solid var(--separator)' }}>
                    <td className="px-4 py-2.5 whitespace-nowrap" style={{ color: 'var(--muted)' }}>
                      {formatDateTime(event.createdAt)}
                    </td>
                    <td className="px-4 py-2.5">
                      {event.clientId && event.clientName ? (
                        <ClientLink clientId={event.clientId} name={event.clientName} onSelect={onSelectClient} />
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-4 py-2.5" style={{ color: 'var(--muted)' }}>
                      {event.taskName ?? '—'}
                    </td>
                    <td className="px-4 py-2.5" style={{ color: 'var(--muted)' }}>
                      {event.step ?? '—'}
                    </td>
                    <td className="px-4 py-2.5">
                      <LevelBadge level={event.level} />
                    </td>
                    <td className="px-4 py-2.5">{event.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between border-t px-4 py-2 text-xs" style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}>
            <span>
              Página {page + 1} de {totalPages}
            </span>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" isDisabled={page === 0} onPress={() => setPage((p) => p - 1)}>
                Anterior
              </Button>
              <Button size="sm" variant="ghost" isDisabled={page + 1 >= totalPages} onPress={() => setPage((p) => p + 1)}>
                Siguiente
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
