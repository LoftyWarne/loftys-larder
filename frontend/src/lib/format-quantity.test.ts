import { describe, expect, it } from 'vitest';

import { formatQuantity } from './format-quantity.ts';

describe('formatQuantity', () => {
  it('drops trailing zeros for g and shows 1 decimal place when needed', () => {
    expect(formatQuantity('300.000', 'g')).toBe('300');
    expect(formatQuantity('300.500', 'g')).toBe('300.5');
    expect(formatQuantity('100.250', 'g')).toBe('100.3'); // rounded to 1 dp
    expect(formatQuantity('0.500', 'g')).toBe('0.5');
  });

  it('strips trailing zeros for non-g units without imposing a cap', () => {
    expect(formatQuantity('1.000', 'piece')).toBe('1');
    expect(formatQuantity('2.500', 'tsp')).toBe('2.5');
    expect(formatQuantity('0.250', 'tsp')).toBe('0.25');
  });

  it('returns the input as-is when it is not a finite number', () => {
    expect(formatQuantity('not-a-number', 'g')).toBe('not-a-number');
  });
});
