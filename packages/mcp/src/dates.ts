import { DateTime } from 'luxon';

/**
 * Dates are resolved here, in code, never by the model.
 *
 * "Tomorrow" depends on where the clinic is, not where the server runs: at
 * 23:30 UTC it is already tomorrow in Bratislava. The clock is injected so
 * tests can stand on either side of midnight.
 */
export interface Clock {
  now(): Date;
  /** IANA timezone of the clinic, e.g. Europe/Bratislava. */
  zone: string;
}

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

function today(clock: Clock): DateTime {
  return DateTime.fromJSDate(clock.now(), { zone: clock.zone }).startOf('day');
}

/**
 * Turns "today", "tomorrow", "Monday", "next Monday" or "2026-11-03" into a
 * local date (YYYY-MM-DD), or `null` if it cannot be read.
 *
 * A bare weekday means the nearest one, today included: on a Monday,
 * "Monday" is today. "next Monday" always skips today.
 */
export function resolveDay(input: string, clock: Clock): string | null {
  const text = input.trim().toLowerCase().replace(/\s+/g, ' ');
  const base = today(clock);

  if (text === '' || text === 'today') return base.toISODate();
  if (text === 'tomorrow') return base.plus({ days: 1 }).toISODate();
  if (text === 'day after tomorrow') return base.plus({ days: 2 }).toISODate();
  if (text === 'yesterday') return base.minus({ days: 1 }).toISODate();

  const weekday = /^(next )?([a-z]+)$/.exec(text);
  if (weekday?.[2]) {
    const index = WEEKDAYS.findIndex((name) => name === weekday[2] || name.slice(0, 3) === weekday[2]);
    if (index !== -1) {
      let ahead = (index + 1 - base.weekday + 7) % 7;
      if (weekday[1] && ahead === 0) ahead = 7;
      return base.plus({ days: ahead }).toISODate();
    }
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const date = DateTime.fromISO(text, { zone: clock.zone });
    return date.isValid ? date.toISODate() : null;
  }

  return null;
}

/**
 * Turns "2026-11-03 09:00", "tomorrow 14:30" or "Monday at 9:15" into a UTC
 * instant (ISO string), reading the time as clinic-local. Returns `null` for
 * anything unreadable, including times that do not exist on a DST change.
 */
export function resolveDateTime(input: string, clock: Clock): string | null {
  const match = /^(.+?)(?:\s+at)?[\sT]+(\d{1,2}):(\d{2})$/i.exec(input.trim());
  if (!match?.[1] || !match[2] || !match[3]) return null;

  const day = resolveDay(match[1], clock);
  const [hour, minute] = [Number(match[2]), Number(match[3])];
  if (!day || hour > 23 || minute > 59) return null;

  const local = DateTime.fromISO(day, { zone: clock.zone }).set({ hour, minute });
  if (!local.isValid || local.hour !== hour || local.minute !== minute) return null;
  return local.toUTC().toISO();
}

/** Start of the local day and start of the next one, both as UTC instants. */
export function dayBounds(day: string, clock: Clock): { from: string; to: string } {
  const start = DateTime.fromISO(day, { zone: clock.zone }).startOf('day');
  return { from: start.toUTC().toISO() ?? '', to: start.plus({ days: 1 }).toUTC().toISO() ?? '' };
}

export function formatDay(dayOrInstant: string, clock: Clock): string {
  return DateTime.fromISO(dayOrInstant, { zone: clock.zone }).setLocale('en-GB').toFormat('cccc d LLLL yyyy');
}

export function formatTime(instant: string, clock: Clock): string {
  return DateTime.fromISO(instant).setZone(clock.zone).toFormat('HH:mm');
}

export function localDate(instant: string, clock: Clock): string {
  return DateTime.fromISO(instant).setZone(clock.zone).toISODate() ?? '';
}

const EURO = new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' });

export function formatMoney(cents: number): string {
  return EURO.format(cents / 100);
}
