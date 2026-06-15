import { describe, expect, it } from 'vitest';

import {
  daysBetween,
  eachDateInRange,
  formatCivilDate,
  parseCivilDate,
  todayInLondon,
} from '../src/lib/date-utils.ts';

describe('date-utils', () => {
  describe('todayInLondon', () => {
    it('is stable across calls within a sub-second window', () => {
      const a = todayInLondon();
      const b = todayInLondon();
      expect(a.getTime()).toBe(b.getTime());
    });

    it('returns a Date at UTC midnight', () => {
      const today = todayInLondon();
      expect(today.getUTCHours()).toBe(0);
      expect(today.getUTCMinutes()).toBe(0);
      expect(today.getUTCSeconds()).toBe(0);
      expect(today.getUTCMilliseconds()).toBe(0);
    });

    it('maps a just-entered-BST instant to the London civil day', () => {
      // 2026-03-29 01:30Z — clocks have just sprung forward at 01:00Z to
      // 02:00 BST. The London civil day is 2026-03-29.
      const just = new Date('2026-03-29T01:30:00Z');
      expect(formatCivilDate(todayInLondon(just))).toBe('2026-03-29');
    });

    it('rolls the civil day at UK midnight, not UTC midnight', () => {
      // 2026-06-15 23:30Z — BST (+1) means it's already 2026-06-16 00:30
      // London time. The London civil day is 2026-06-16.
      const lateNightUk = new Date('2026-06-15T23:30:00Z');
      expect(formatCivilDate(todayInLondon(lateNightUk))).toBe('2026-06-16');
    });

    it('treats the pre-BST winter window as UTC-aligned', () => {
      // 2026-01-15 23:30Z is GMT — 23:30 London. Civil day still 2026-01-15.
      const winterLate = new Date('2026-01-15T23:30:00Z');
      expect(formatCivilDate(todayInLondon(winterLate))).toBe('2026-01-15');
    });
  });

  describe('parseCivilDate / formatCivilDate', () => {
    it('round-trips a YYYY-MM-DD string', () => {
      const date = parseCivilDate('2026-06-15');
      expect(formatCivilDate(date)).toBe('2026-06-15');
    });

    it('rejects malformed input', () => {
      expect(() => parseCivilDate('2026-6-15')).toThrow();
      expect(() => parseCivilDate('15/06/2026')).toThrow();
      expect(() => parseCivilDate('')).toThrow();
    });
  });

  describe('eachDateInRange', () => {
    it('returns one entry per day inclusive of both ends', () => {
      const days = eachDateInRange(
        parseCivilDate('2026-06-15'),
        parseCivilDate('2026-06-17'),
      );
      expect(days.map(formatCivilDate)).toEqual([
        '2026-06-15',
        '2026-06-16',
        '2026-06-17',
      ]);
    });

    it('returns a single day when start === end', () => {
      const day = parseCivilDate('2026-06-15');
      const days = eachDateInRange(day, day);
      expect(days.map(formatCivilDate)).toEqual(['2026-06-15']);
    });

    it('spans a BST DST transition cleanly', () => {
      // 28th -> 29th -> 30th March around the spring-forward.
      const days = eachDateInRange(
        parseCivilDate('2026-03-28'),
        parseCivilDate('2026-03-30'),
      );
      expect(days.map(formatCivilDate)).toEqual([
        '2026-03-28',
        '2026-03-29',
        '2026-03-30',
      ]);
    });

    it('throws on an inverted range', () => {
      expect(() =>
        eachDateInRange(
          parseCivilDate('2026-06-17'),
          parseCivilDate('2026-06-15'),
        ),
      ).toThrow();
    });
  });

  describe('daysBetween', () => {
    it('returns 1 for a single-day range', () => {
      const d = parseCivilDate('2026-06-15');
      expect(daysBetween(d, d)).toBe(1);
    });

    it('counts inclusive days', () => {
      expect(
        daysBetween(parseCivilDate('2026-06-15'), parseCivilDate('2026-06-21')),
      ).toBe(7);
    });

    it('is DST-stable', () => {
      expect(
        daysBetween(parseCivilDate('2026-03-28'), parseCivilDate('2026-03-30')),
      ).toBe(3);
    });
  });
});
