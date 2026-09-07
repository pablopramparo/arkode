import type { RefreshOutcome } from './refreshSnapshot';

export function formatAge(isoTimestamp: string, now: Date = new Date()): string {
  const ms = Math.max(0, now.getTime() - new Date(isoTimestamp).getTime());
  const hours = Math.round(ms / (1000 * 60 * 60));
  if (hours < 1) return 'hace menos de una hora';
  if (hours < 48) return `hace ${hours} h`;
  return `hace ${Math.round(hours / 24)} d`;
}

export type FreshnessBannerKind = 'fresh' | 'offline' | 'needs_reconnect' | 'update_failed' | 'possibly_revoked' | 'unsupported_format' | 'never_synced';

export interface FreshnessBanner {
  kind: FreshnessBannerKind;
  label: string;
}

/**
 * Turns "when was the last GOOD snapshot generated" + "what happened on the
 * most recent check" into exactly the copy the home screen shows. The hard
 * rule this encodes: never say "sincronizado"/imply success unless the
 * last check actually confirmed the cache is current — every failure mode
 * gets its own honest label, but ALWAYS alongside the age of the last good
 * data, never a bare error with no fallback context.
 */
export function freshnessBannerFor(lastGoodGeneratedAt: string | null, lastOutcome: RefreshOutcome | null, now: Date = new Date()): FreshnessBanner {
  if (!lastGoodGeneratedAt) {
    return { kind: 'never_synced', label: 'Todavía no se descargó ninguna actualización' };
  }
  const age = formatAge(lastGoodGeneratedAt, now);

  if (!lastOutcome || lastOutcome.kind === 'updated' || lastOutcome.kind === 'up_to_date') {
    return { kind: 'fresh', label: `Actualizado ${age}` };
  }

  switch (lastOutcome.kind) {
    case 'network_error':
      return { kind: 'offline', label: `Sin conexión — mostrando la copia de ${age}` };
    case 'oauth_error':
      return { kind: 'needs_reconnect', label: `Google Drive necesita reconexión — mostrando la copia de ${age}` };
    case 'corrupt':
      return { kind: 'update_failed', label: `No se pudo verificar la última actualización — mostrando la copia de ${age}` };
    case 'decrypt_failed':
      return { kind: 'possibly_revoked', label: 'Este dispositivo puede haber sido revocado o su clave cambió — volvé a vincularlo desde Arkode Desktop' };
    case 'unsupported_format':
      return { kind: 'unsupported_format', label: 'Esta actualización requiere una versión más nueva de Arkode Pocket' };
  }
}
