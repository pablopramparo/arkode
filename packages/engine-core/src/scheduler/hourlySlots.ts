import { HOURLY_INTERVAL_CHOICES } from '../types.js';

/**
 * Pure date math for the 'hourly' ("cada N horas") schedule frequency, shared
 * by isTaskDue / isFileBackupTaskDue / nextScheduledRunAt so all three agree
 * on what a "slot" is.
 *
 * Slots are anchor + k·N hours for every integer k (negative too), on the
 * local wall clock. Because N divides 24 the pattern is identical every day:
 * minutes-of-day ≡ anchorMinutes (mod N·60). 03:00 with N=6 → 03:00, 09:00,
 * 15:00, 21:00; 05:00 with N=4 → 01:00, 05:00, 09:00, 13:00, 17:00, 21:00.
 */

export function isValidIntervalHours(n: unknown): n is (typeof HOURLY_INTERVAL_CHOICES)[number] {
  return typeof n === 'number' && (HOURLY_INTERVAL_CHOICES as readonly number[]).includes(n);
}

function parseAnchor(anchor: string): number | null {
  const [h, m] = anchor.split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

/** Wall-clock time `minutesOfDay` after local midnight of `now`'s date (negative / ≥1440 roll to the previous / next day). */
function atMinutes(now: Date, minutesOfDay: number): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, minutesOfDay, 0, 0);
}

/** The most recent slot at or before `now`, or null if the anchor/interval is invalid. */
export function latestHourlySlot(anchor: string, intervalHours: number, now: Date): Date | null {
  const anchorMin = parseAnchor(anchor);
  if (anchorMin == null || !isValidIntervalHours(intervalHours)) return null;
  const step = intervalHours * 60;
  const nowMin = now.getHours() * 60 + now.getMinutes();
  // First slot-minute of the local day (mathematical mod, so always 0 <= offset < step).
  const offset = ((anchorMin % step) + step) % step;
  let slotMin = offset + Math.floor((nowMin - offset) / step) * step; // negative → previous day
  let slot = atMinutes(now, slotMin);
  // Guard against DST wall-clock quirks producing a slot slightly after `now`.
  while (slot.getTime() > now.getTime()) {
    slotMin -= step;
    slot = atMinutes(now, slotMin);
  }
  return slot;
}

/** The first slot strictly after `now`, or null if the anchor/interval is invalid. */
export function nextHourlySlot(anchor: string, intervalHours: number, now: Date): Date | null {
  const latest = latestHourlySlot(anchor, intervalHours, now);
  if (!latest) return null;
  // `latest` is the greatest slot <= now, so latest + N hours is the first one after now.
  return new Date(
    latest.getFullYear(),
    latest.getMonth(),
    latest.getDate(),
    latest.getHours() + intervalHours,
    latest.getMinutes(),
    0,
    0
  );
}
