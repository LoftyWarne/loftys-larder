import { describe, expect, it } from 'vitest';

import { normaliseHealthScore } from '../src/lib/health-score/normalise.ts';

const candidate = {
  score: 7,
  summary: 'Lots of vegetables and fibre, but quite salty.',
  suggestion: 'Halve the stock cube.',
};

describe('normaliseHealthScore', () => {
  it('passes a good result through', () => {
    expect(normaliseHealthScore(candidate)).toEqual(candidate);
  });

  it.each([1, 10])('accepts a score of %i', (score) => {
    expect(normaliseHealthScore({ ...candidate, score })?.score).toBe(score);
  });

  it('accepts a whole number written as a float', () => {
    expect(normaliseHealthScore({ ...candidate, score: 7.0 })?.score).toBe(7);
  });

  it.each([0, 11, 7.5, -3])('refuses a score of %d', (score) => {
    expect(normaliseHealthScore({ ...candidate, score })).toBeNull();
  });

  it('keeps a null Suggestion', () => {
    expect(
      normaliseHealthScore({ ...candidate, suggestion: null })?.suggestion,
    ).toBeNull();
  });

  it.each(['', '   ', '**  **'])(
    'turns an empty Suggestion (%j) into none',
    (suggestion) => {
      expect(
        normaliseHealthScore({ ...candidate, suggestion })?.suggestion,
      ).toBeNull();
    },
  );

  it('strips markdown from the summary and the Suggestion', () => {
    const result = normaliseHealthScore({
      score: 6,
      summary: '**High in fibre**, but _quite_ salty.',
      suggestion: '- Use `low-salt` stock.',
    });
    expect(result).toEqual({
      score: 6,
      summary: 'High in fibre, but quite salty.',
      suggestion: 'Use low-salt stock.',
    });
  });

  it('measures lengths after stripping markdown', () => {
    const summary = `**${'a'.repeat(300)}**`;
    expect(normaliseHealthScore({ ...candidate, summary })?.summary).toBe(
      'a'.repeat(300),
    );
  });

  it('refuses a summary over 300 characters', () => {
    expect(
      normaliseHealthScore({ ...candidate, summary: 'a'.repeat(301) }),
    ).toBeNull();
  });

  it('refuses an empty summary', () => {
    expect(normaliseHealthScore({ ...candidate, summary: ' ' })).toBeNull();
  });

  it('refuses a Suggestion over 200 characters', () => {
    expect(
      normaliseHealthScore({ ...candidate, suggestion: 'a'.repeat(201) }),
    ).toBeNull();
  });

  it.each([
    ['null', null],
    ['a string', '7'],
    ['a missing summary', { score: 7, suggestion: null }],
    ['a string score', { ...candidate, score: '7' }],
    ['a missing Suggestion', { score: 7, summary: 'Fine.' }],
  ])('refuses a malformed result: %s', (_label, value) => {
    expect(normaliseHealthScore(value)).toBeNull();
  });
});
