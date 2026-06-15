import { describe, expect, it } from 'vitest';

import {
  clampRange,
  eachDateInRange,
  formatCivilDate,
  formatDayLabel,
  parseCivilDate,
  todayInLondon,
} from './date-utils.ts';

describe('parseCivilDate', () => {
  it('parses a YYYY-MM-DD string', () => {
    expect(parseCivilDate('2026-06-15')).toEqual({
      year: 2026,
      month: 6,
      day: 15,
    });
  });

  it('rejects malformed input', () => {
    expect(() => parseCivilDate('15/06/2026')).toThrow();
  });
});

describe('formatCivilDate', () => {
  it('round-trips with parseCivilDate', () => {
    const iso = '2026-01-09';
    expect(formatCivilDate(parseCivilDate(iso))).toBe(iso);
  });

  it('pads year, month, and day', () => {
    expect(formatCivilDate({ year: 26, month: 1, day: 9 })).toBe('0026-01-09');
  });
});

describe('eachDateInRange', () => {
  it('returns inclusive YYYY-MM-DD strings', () => {
    expect(eachDateInRange('2026-06-13', '2026-06-15')).toEqual([
      '2026-06-13',
      '2026-06-14',
      '2026-06-15',
    ]);
  });

  it('returns a single date when start === end', () => {
    expect(eachDateInRange('2026-06-15', '2026-06-15')).toEqual(['2026-06-15']);
  });

  it('crosses a DST boundary cleanly', () => {
    // BST starts on the last Sunday of March; this range spans it. Result
    // must still be 4 consecutive civil days.
    const dates = eachDateInRange('2026-03-28', '2026-03-31');
    expect(dates).toEqual([
      '2026-03-28',
      '2026-03-29',
      '2026-03-30',
      '2026-03-31',
    ]);
  });

  it('throws on inverted ranges', () => {
    expect(() => eachDateInRange('2026-06-16', '2026-06-15')).toThrow();
  });
});

describe('clampRange', () => {
  it('returns plan range when no visible bounds supplied', () => {
    expect(
      clampRange('2026-06-01', '2026-06-07', undefined, undefined),
    ).toEqual({ start: '2026-06-01', end: '2026-06-07' });
  });

  it('clamps visible bounds inside the plan', () => {
    expect(
      clampRange('2026-06-01', '2026-06-07', '2026-05-20', '2026-06-30'),
    ).toEqual({ start: '2026-06-01', end: '2026-06-07' });
  });

  it('keeps tighter visible bounds when they fit inside the plan', () => {
    expect(
      clampRange('2026-06-01', '2026-06-07', '2026-06-03', '2026-06-05'),
    ).toEqual({ start: '2026-06-03', end: '2026-06-05' });
  });

  it('returns null when the clamped window collapses', () => {
    expect(
      clampRange('2026-06-01', '2026-06-07', '2026-06-08', '2026-06-09'),
    ).toBeNull();
  });
});

describe('todayInLondon', () => {
  it('returns a YYYY-MM-DD string', () => {
    expect(todayInLondon()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('reflects the supplied instant in Europe/London civil time', () => {
    // Midnight UTC on 2026-06-15 is 01:00 BST — civil day in London is the 15th.
    expect(todayInLondon(new Date('2026-06-15T00:00:00Z'))).toBe('2026-06-15');
  });

  it('respects the London civil-day boundary after midnight UTC in winter', () => {
    // 23:30 UTC on 2026-01-14 is 23:30 GMT (no DST) — still the 14th in London.
    expect(todayInLondon(new Date('2026-01-14T23:30:00Z'))).toBe('2026-01-14');
  });
});

describe('formatDayLabel', () => {
  it('renders weekday + day + month', () => {
    const label = formatDayLabel('2026-06-15');
    // Locale exact format may vary slightly; we assert key tokens.
    expect(label).toMatch(/Mon/);
    expect(label).toMatch(/15/);
    expect(label).toMatch(/Jun/);
  });
});
