import { freshnessBannerFor, formatAge } from './freshness';
import type { RefreshOutcome } from './refreshSnapshot';

const NOW = new Date('2026-01-02T12:00:00.000Z');
const THREE_HOURS_AGO = new Date(NOW.getTime() - 3 * 60 * 60 * 1000).toISOString();

describe('freshnessBannerFor — never claim success when the last check did not confirm it', () => {
  it('never synced yet', () => {
    expect(freshnessBannerFor(null, null, NOW)).toEqual({ kind: 'never_synced', label: 'Todavía no se descargó ninguna actualización' });
  });

  it('fresh: last check either updated or confirmed up to date', () => {
    expect(freshnessBannerFor(THREE_HOURS_AGO, null, NOW)).toEqual({ kind: 'fresh', label: 'Actualizado hace 3 h' });
    expect(freshnessBannerFor(THREE_HOURS_AGO, { kind: 'up_to_date' }, NOW).kind).toBe('fresh');
    expect(freshnessBannerFor(THREE_HOURS_AGO, { kind: 'updated', revision: 2 }, NOW).kind).toBe('fresh');
  });

  it('offline: keeps showing the age of the last GOOD copy, not a bare error', () => {
    const outcome: RefreshOutcome = { kind: 'network_error', message: 'timeout' };
    const banner = freshnessBannerFor(THREE_HOURS_AGO, outcome, NOW);
    expect(banner.kind).toBe('offline');
    expect(banner.label).toContain('hace 3 h');
  });

  it('OAuth expired/revoked: needs_reconnect, last-good data still referenced', () => {
    const outcome: RefreshOutcome = { kind: 'oauth_error', message: 'x' };
    expect(freshnessBannerFor(THREE_HOURS_AGO, outcome, NOW).kind).toBe('needs_reconnect');
  });

  it('corrupt update: update_failed, old copy kept', () => {
    const outcome: RefreshOutcome = { kind: 'corrupt', message: 'x' };
    expect(freshnessBannerFor(THREE_HOURS_AGO, outcome, NOW).kind).toBe('update_failed');
  });

  it('decrypt failure: possibly_revoked, suggests re-pairing explicitly', () => {
    const outcome: RefreshOutcome = { kind: 'decrypt_failed', message: 'x' };
    const banner = freshnessBannerFor(THREE_HOURS_AGO, outcome, NOW);
    expect(banner.kind).toBe('possibly_revoked');
    expect(banner.label.toLowerCase()).toContain('vincul');
  });

  it('unsupported format: tells the user to update the app, not a generic error', () => {
    const outcome: RefreshOutcome = { kind: 'unsupported_format', message: 'x' };
    const banner = freshnessBannerFor(THREE_HOURS_AGO, outcome, NOW);
    expect(banner.kind).toBe('unsupported_format');
    expect(banner.label).toContain('Arkode Pocket');
  });
});

describe('formatAge', () => {
  it('under an hour reads as "menos de una hora"', () => {
    expect(formatAge(new Date(NOW.getTime() - 5 * 60 * 1000).toISOString(), NOW)).toBe('hace menos de una hora');
  });
  it('switches to days past 48h', () => {
    expect(formatAge(new Date(NOW.getTime() - 72 * 60 * 60 * 1000).toISOString(), NOW)).toBe('hace 3 d');
  });
});
