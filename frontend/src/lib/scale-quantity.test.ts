import { describe, expect, it } from 'vitest';

import { formatScaledQuantity } from './scale-quantity.ts';

describe('formatScaledQuantity', () => {
  it('renders exactly as formatQuantity does when not scaled', () => {
    expect(formatScaledQuantity(300, 'g', 1)).toBe('300');
    expect(formatScaledQuantity(100.25, 'g', 1)).toBe('100.3');
    expect(formatScaledQuantity(1.5, 'tsp', 1)).toBe('1.5');
    expect(formatScaledQuantity(0.333, 'piece', 1)).toBe('0.333');
    expect(formatScaledQuantity(0.1 + 0.2, 'tbsp', 1)).toBe('0.3');
  });

  it.each([
    [200, 'g', 4 / 3, '267'],
    [5, 'g', 1.5, '7.5'],
    [10, 'ml', 0.5, '5'],
    [4, 'g', 2.4, '9.6'],
    [3, 'ml', 3.333, '10'],
    [1.5, 'kg', 4 / 3, '2'],
    [1.25, 'l', 1.5, '1.88'],
    [0.01, 'g', 0.25, '0.003'],
  ])('rounds %s %s × %s to %s', (quantity, unit, factor, expected) => {
    expect(formatScaledQuantity(quantity, unit, factor)).toBe(expected);
  });

  it.each([
    [1, 'tsp', 1.5, '1½'],
    [2, 'tbsp', 1.25, '2½'],
    [1, 'cup', 0.75, '¾'],
    [3, 'piece', 4 / 3, '4'],
    [1, 'piece', 1 / 3, '¼'],
    [1, 'tsp', 0.05, '¼'],
    [4, 'piece', 1.5, '6'],
  ])(
    'rounds %s %s × %s to the nearest quarter: %s',
    (quantity, unit, factor, expected) => {
      expect(formatScaledQuantity(quantity, unit, factor)).toBe(expected);
    },
  );

  it('rounds pinches to a whole number, never below one', () => {
    expect(formatScaledQuantity(1, 'pinch', 2.6)).toBe('3');
    expect(formatScaledQuantity(1, 'pinch', 0.25)).toBe('1');
  });

  it('keeps up to 2 dp for a unit it has no rule for', () => {
    expect(formatScaledQuantity(1, 'tin', 1.5)).toBe('1.5');
    expect(formatScaledQuantity(1, 'tin', 1 / 3)).toBe('0.33');
  });
});
