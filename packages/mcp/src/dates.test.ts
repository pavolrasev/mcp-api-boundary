import { describe, expect, it } from 'vitest';
import { dayBounds, formatMoney, resolveDateTime, resolveDay, type Clock } from './dates.js';

const at = (iso: string): Clock => ({ now: () => new Date(iso), zone: 'Europe/Bratislava' });

describe('resolveDay around midnight', () => {
  it('is already tomorrow in Bratislava at 23:30 UTC', () => {
    /* Monday 23:30 UTC is Tuesday 00:30 in Bratislava (CET, UTC+1). */
    const clock = at('2026-11-02T23:30:00Z');
    expect(resolveDay('today', clock)).toBe('2026-11-03');
    expect(resolveDay('tomorrow', clock)).toBe('2026-11-04');
    expect(resolveDay('yesterday', clock)).toBe('2026-11-02');
  });

  it('is still today one minute before local midnight', () => {
    const clock = at('2026-11-03T22:59:00Z');
    expect(resolveDay('today', clock)).toBe('2026-11-03');
  });

  it('uses the summer offset in July', () => {
    /* 22:30 UTC is 00:30 the next day in CEST (UTC+2), but 23:30 the same day in CET. */
    expect(resolveDay('today', at('2026-07-14T22:30:00Z'))).toBe('2026-07-15');
    expect(resolveDay('today', at('2026-01-14T22:30:00Z'))).toBe('2026-01-14');
  });

  it('would get the day wrong in UTC, which is the point', () => {
    const clock: Clock = { now: () => new Date('2026-11-02T23:30:00Z'), zone: 'UTC' };
    expect(resolveDay('today', clock)).toBe('2026-11-02');
  });
});

describe('resolveDay with weekdays and dates', () => {
  const tuesday = at('2026-11-03T09:00:00Z');

  it.each([
    ['Monday', '2026-11-09'],
    ['tuesday', '2026-11-03'],
    ['next Tuesday', '2026-11-10'],
    ['fri', '2026-11-06'],
    ['2026-12-24', '2026-12-24'],
    ['day after tomorrow', '2026-11-05'],
  ])('%s is %s', (input, expected) => {
    expect(resolveDay(input, tuesday)).toBe(expected);
  });

  it.each(['someday', '2026-02-30', '03.11.2026', 'next'])('cannot read %s', (input) => {
    expect(resolveDay(input, tuesday)).toBeNull();
  });
});

describe('resolveDateTime', () => {
  const clock = at('2026-11-02T23:30:00Z');

  it('reads local clinic time and returns UTC', () => {
    expect(resolveDateTime('2026-11-03 09:00', clock)).toBe('2026-11-03T08:00:00.000Z');
    expect(resolveDateTime('2026-07-15 09:00', clock)).toBe('2026-07-15T07:00:00.000Z');
    expect(resolveDateTime('2026-11-03T09:00', clock)).toBe('2026-11-03T08:00:00.000Z');
  });

  it('reads relative days from the local date, not the UTC one', () => {
    expect(resolveDateTime('tomorrow 9:15', clock)).toBe('2026-11-04T08:15:00.000Z');
    expect(resolveDateTime('Monday at 14:30', clock)).toBe('2026-11-09T13:30:00.000Z');
  });

  it('refuses times that do not exist or cannot be read', () => {
    expect(resolveDateTime('2026-03-29 02:30', clock)).toBeNull();
    expect(resolveDateTime('tomorrow 25:00', clock)).toBeNull();
    expect(resolveDateTime('tomorrow', clock)).toBeNull();
  });
});

describe('dayBounds and money', () => {
  it('covers the local day in UTC', () => {
    expect(dayBounds('2026-11-03', at('2026-11-03T09:00:00Z'))).toEqual({
      from: '2026-11-02T23:00:00.000Z',
      to: '2026-11-03T23:00:00.000Z',
    });
  });

  it('formats cents as euros', () => {
    expect(formatMoney(4050)).toBe('€40.50');
  });
});
