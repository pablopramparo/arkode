import { useCallback, useEffect, useState } from 'react';
import { Button } from '@heroui/react';
import { isTauri } from '@tauri-apps/api/core';
import {
  getSchedulerServiceStatus,
  restartSchedulerService,
  reinstallSchedulerService,
  fetchSchedulerHeartbeat,
  type SchedulerServiceStatus,
} from '../lib/schedulerClient';

const POLL_MS = 30_000;
/** A tick runs every 60s; give it slack before calling a running service "silent". */
const STALE_HEARTBEAT_SECONDS = 5 * 60;

type Tone = 'ok' | 'warn' | 'bad' | 'muted';

const TONE_STYLE: Record<Tone, { border: string; bg: string; fg: string }> = {
  ok: { border: 'var(--success)', bg: 'color-mix(in oklab, var(--success) 8%, transparent)', fg: 'var(--success)' },
  warn: { border: 'var(--warning)', bg: 'color-mix(in oklab, var(--warning) 8%, transparent)', fg: 'var(--warning)' },
  bad: { border: 'var(--danger)', bg: 'color-mix(in oklab, var(--danger) 10%, transparent)', fg: 'var(--danger)' },
  muted: { border: 'var(--border)', bg: 'var(--surface-secondary)', fg: 'var(--muted)' },
};

function ageLabel(seconds: number): string {
  if (seconds < 90) return `hace ${seconds}s`;
  if (seconds < 5400) return `hace ${Math.round(seconds / 60)} min`;
  return `hace ${Math.round(seconds / 3600)} h`;
}

/**
 * The arkode-scheduler Windows service's health. Green when it's running and
 * has ticked recently; otherwise offers Reiniciar / Reinstalar (one UAC
 * prompt each). Shown on the Dashboard and in Configuración.
 */
export function SchedulerStatusBanner() {
  const [status, setStatus] = useState<SchedulerServiceStatus | null>(null);
  const [heartbeat, setHeartbeat] = useState<{ heartbeatAt: string | null; heartbeatAgeSeconds: number | null } | null>(null);
  const [busy, setBusy] = useState<'restart' | 'reinstall' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, h] = await Promise.all([
        getSchedulerServiceStatus(),
        fetchSchedulerHeartbeat().catch(() => null),
      ]);
      setStatus(s);
      setHeartbeat(h);
    } catch {
      /* leave the last known state */
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  async function act(kind: 'restart' | 'reinstall') {
    setBusy(kind);
    setActionError(null);
    try {
      await (kind === 'restart' ? restartSchedulerService() : reinstallSchedulerService());
      await new Promise((r) => setTimeout(r, 1000));
      await refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  if (!isTauri()) {
    return (
      <Banner tone="muted">
        El servicio de backups solo corre en la app instalada — en modo desarrollo los backups programados no se
        ejecutan solos.
      </Banner>
    );
  }

  if (status == null) return null; // first load

  let tone: Tone;
  let message: string;
  const canRestart = status.installed;
  const showReinstall = !status.installed || !status.running;

  if (!status.installed) {
    tone = 'bad';
    message = '⚠ El servicio de backups no está instalado — los backups programados no van a correr.';
  } else if (!status.running) {
    tone = 'bad';
    message = '⚠ El servicio de backups está detenido — los backups programados no van a correr.';
  } else if (heartbeat?.heartbeatAgeSeconds == null) {
    tone = 'warn';
    message = 'El servicio está activo pero todavía no completó un ciclo.';
  } else if (heartbeat.heartbeatAgeSeconds > STALE_HEARTBEAT_SECONDS) {
    tone = 'warn';
    message = `⚠ El servicio está corriendo pero no reporta actividad (última señal ${ageLabel(heartbeat.heartbeatAgeSeconds)}).`;
  } else {
    tone = 'ok';
    message = `● Servicio de backups activo · última señal ${ageLabel(heartbeat.heartbeatAgeSeconds)}`;
  }

  return (
    <Banner tone={tone}>
      <span>{message}</span>
      {(canRestart || showReinstall) && (
        <span className="ml-auto flex items-center gap-2">
          {canRestart && (
            <Button
              size="sm"
              variant="ghost"
              className="rounded-full px-3"
              isDisabled={busy != null}
              onPress={() => act('restart')}
            >
              {busy === 'restart' ? 'Reiniciando…' : 'Reiniciar'}
            </Button>
          )}
          {showReinstall && (
            <Button
              size="sm"
              variant="ghost"
              className="rounded-full px-3"
              isDisabled={busy != null}
              onPress={() => act('reinstall')}
            >
              {busy === 'reinstall' ? 'Reinstalando…' : 'Reinstalar'}
            </Button>
          )}
        </span>
      )}
      {actionError && (
        <span className="w-full text-xs" style={{ color: 'var(--danger)' }}>
          {actionError}
        </span>
      )}
    </Banner>
  );
}

function Banner({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  const s = TONE_STYLE[tone];
  return (
    <div
      className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-4 py-2.5 text-sm"
      style={{ borderColor: s.border, backgroundColor: s.bg, color: s.fg }}
    >
      {children}
    </div>
  );
}
