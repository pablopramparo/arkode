import { useEffect, useState } from 'react';
import type { VaultCredential, VaultItem, VaultItemType, VaultUrl } from 'engine-core';
import { searchVault } from '../lib/vaultClient';
import { formatAge } from '../lib/format';

/** Backup-domain figures derived in ClienteDetalle from data it already holds — no new API. */
export interface ResumenBackupStats {
  tasks: number;
  connections: number;
  storedBackups: number;
  /** Rows currently loaded in the Historial tab (capped). */
  runsShown: number;
  /** The Historial fetch hit its 100-row cap — show the count as "N+". */
  runsCapped: boolean;
  lastGoodBackupAt: string | null;
  /** Active tasks whose latest attempt failed. */
  failingTasks: number;
}

export type ResumenNavTarget =
  | { main: 'backups'; sub: 'tareas' | 'conexiones' | 'backups' | 'historial' }
  | { main: 'proyecto'; sub: 'credenciales' | 'urls' | 'snippets' | 'procesos' | 'notas' };

/** ~26 h without a fresh good backup for a daily task is worth a soft flag (mirrors the Dashboard's STALE_THRESHOLD_HOURS). */
const STALE_HOURS = 26;

/**
 * The client ficha's "Resumen" tab — transversal to Backups + Proyecto.
 * Every card navigates to its section. Not a mini-dashboard: counts + one
 * status line, scoped to this client.
 */
export function ClienteResumen({
  clientId,
  backups,
  onNavigate,
}: {
  clientId: string;
  backups: ResumenBackupStats;
  onNavigate: (target: ResumenNavTarget) => void;
}) {
  const [vault, setVault] = useState<{ credentials: VaultCredential[]; urls: VaultUrl[]; items: VaultItem[] } | null>(null);

  useEffect(() => {
    void searchVault('', clientId).then((r) => setVault({ credentials: r.credentials, urls: r.urls, items: r.items }));
  }, [clientId]);

  const countItems = (t: VaultItemType) => vault?.items.filter((i) => i.type === t).length ?? 0;
  const favCreds = vault?.credentials.filter((c) => c.favorite) ?? [];
  const favUrls = vault?.urls.filter((u) => u.favorite) ?? [];
  const favItems = vault?.items.filter((i) => i.favorite) ?? [];

  const lastGoodHours = backups.lastGoodBackupAt
    ? (Date.now() - new Date(backups.lastGoodBackupAt).getTime()) / 3_600_000
    : null;

  let statusTone = 'var(--success)';
  let statusText = 'Al día';
  let statusTarget: ResumenNavTarget | null = null;
  if (backups.failingTasks > 0) {
    statusTone = 'var(--danger)';
    statusText = `${backups.failingTasks} ${backups.failingTasks === 1 ? 'tarea con error' : 'tareas con error'}`;
    statusTarget = { main: 'backups', sub: 'tareas' };
  } else if (lastGoodHours == null || lastGoodHours > STALE_HOURS) {
    statusTone = 'var(--warning)';
    statusText = 'Sin backup reciente';
    statusTarget = { main: 'backups', sub: 'historial' };
  }

  const Card = ({ label, value, target }: { label: string; value: React.ReactNode; target: ResumenNavTarget }) => (
    <button
      type="button"
      onClick={() => onNavigate(target)}
      className="rounded-lg border px-4 py-3 text-left transition-colors"
      style={{ borderColor: 'var(--border)' }}
      onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'var(--accent)')}
      onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'var(--border)')}
    >
      <div className="text-2xl font-semibold">{value}</div>
      <div className="text-xs" style={{ color: 'var(--muted)' }}>
        {label}
      </div>
    </button>
  );

  return (
    <div className="mt-3 space-y-6">
      <section>
        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--muted)' }}>
          Backups
        </h3>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <Card label="Tareas" value={backups.tasks} target={{ main: 'backups', sub: 'tareas' }} />
          <Card label="Conexiones" value={backups.connections} target={{ main: 'backups', sub: 'conexiones' }} />
          <Card label="Backups" value={backups.storedBackups} target={{ main: 'backups', sub: 'backups' }} />
          <Card
            label="Ejecuciones"
            value={`${backups.runsShown}${backups.runsCapped ? '+' : ''}`}
            target={{ main: 'backups', sub: 'historial' }}
          />
          <Card
            label="Último backup"
            value={<span className="text-lg">{backups.lastGoodBackupAt ? formatAge(backups.lastGoodBackupAt) : '—'}</span>}
            target={{ main: 'backups', sub: 'historial' }}
          />
        </div>
        <button
          type="button"
          onClick={() => statusTarget && onNavigate(statusTarget)}
          className="mt-2 flex items-center gap-1.5 text-sm"
          style={{ color: statusTone, cursor: statusTarget ? 'pointer' : 'default' }}
        >
          <span aria-hidden>●</span>
          {statusText}
        </button>
      </section>

      <section>
        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--muted)' }}>
          Proyecto
        </h3>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <Card label="Credenciales" value={vault?.credentials.length ?? 0} target={{ main: 'proyecto', sub: 'credenciales' }} />
          <Card label="URLs" value={vault?.urls.length ?? 0} target={{ main: 'proyecto', sub: 'urls' }} />
          <Card label="Snippets" value={countItems('snippet')} target={{ main: 'proyecto', sub: 'snippets' }} />
          <Card label="Procesos" value={countItems('process')} target={{ main: 'proyecto', sub: 'procesos' }} />
          <Card label="Notas" value={countItems('note')} target={{ main: 'proyecto', sub: 'notas' }} />
        </div>
      </section>

      {(favCreds.length > 0 || favUrls.length > 0 || favItems.length > 0) && (
        <section>
          <h3 className="mb-2 text-sm font-medium">Fijados</h3>
          <ul className="space-y-1 text-sm">
            {favCreds.map((c) => (
              <li key={c.id}>
                <span style={{ color: 'var(--muted)' }}>[credencial]</span> {c.name}
              </li>
            ))}
            {favUrls.map((u) => (
              <li key={u.id}>
                <a href={u.url} target="_blank" rel="noreferrer" className="underline" style={{ color: 'var(--accent)' }}>
                  {u.name}
                </a>
              </li>
            ))}
            {favItems.map((i) => (
              <li key={i.id}>
                <span style={{ color: 'var(--muted)' }}>[{i.type}]</span> {i.title}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
