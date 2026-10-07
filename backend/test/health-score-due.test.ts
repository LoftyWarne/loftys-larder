import { describe, expect, it } from 'vitest';

import { healthScoreDueReason } from '../src/lib/health-score/due.ts';

const SINCE = '2026-10-07';

describe('healthScoreDueReason', () => {
  it('is not scored without a score', () => {
    expect(healthScoreDueReason(null, SINCE)).toBe('not_scored');
  });

  it('is current for a fresh score made on or after the date', () => {
    const score = {
      isStale: false,
      scoredAt: new Date('2026-10-07T09:00:00Z'),
    };
    expect(healthScoreDueReason(score, SINCE)).toBeNull();
  });

  it('is out of date when stale', () => {
    const score = { isStale: true, scoredAt: new Date('2026-10-08T09:00:00Z') };
    expect(healthScoreDueReason(score, SINCE)).toBe('out_of_date');
  });

  it('is from an older scorer when scored before the date', () => {
    const score = {
      isStale: false,
      scoredAt: new Date('2026-10-06T12:00:00Z'),
    };
    expect(healthScoreDueReason(score, SINCE)).toBe('older_scorer');
  });

  it('puts out of date before an older scorer', () => {
    const score = { isStale: true, scoredAt: new Date('2026-10-01T12:00:00Z') };
    expect(healthScoreDueReason(score, SINCE)).toBe('out_of_date');
  });

  it('reads the day in London, not UTC', () => {
    // 23:30 UTC on the 6th is 00:30 on the 7th in London (BST).
    const score = {
      isStale: false,
      scoredAt: new Date('2026-10-06T23:30:00Z'),
    };
    expect(healthScoreDueReason(score, SINCE)).toBeNull();
  });
});
