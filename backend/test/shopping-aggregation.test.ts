import { describe, expect, it } from 'vitest';

import {
  aggregateContributions,
  type ShoppingContribution,
} from '../src/lib/shopping-aggregation.ts';

// Pure-helper tests for the shopping aggregation math. The procedure feeds
// SQL-scaled numeric(10,3) strings in; the helper groups, sums, and orders.
// No DB — every input row is fabricated.

function contribution(
  overrides: Partial<ShoppingContribution> = {},
): ShoppingContribution {
  return {
    slotId: 1,
    slotDate: '2026-01-01',
    recipeId: 1,
    recipeName: 'Recipe',
    ingredientId: 1,
    ingredientName: 'Onion',
    categoryId: 1,
    categoryName: 'Produce',
    unitId: 1,
    unitName: 'unit',
    scaledQuantity: '1.000',
    ...overrides,
  };
}

describe('aggregateContributions', () => {
  it('returns no categories for empty input', () => {
    expect(aggregateContributions([])).toEqual([]);
  });

  it('produces one line per ingredient with one contributing slot', () => {
    const result = aggregateContributions([
      contribution({ scaledQuantity: '2.000' }),
    ]);

    expect(result).toEqual([
      {
        category: { id: 1, name: 'Produce' },
        lines: [
          {
            ingredient: { id: 1, name: 'Onion' },
            unit: { id: 1, name: 'unit' },
            totalQuantity: '2.000',
            contributingSlots: [
              {
                slotId: 1,
                recipeId: 1,
                recipeName: 'Recipe',
                date: '2026-01-01',
                scaledQuantity: '2.000',
              },
            ],
          },
        ],
      },
    ]);
  });

  it('sums two slots contributing the same ingredient', () => {
    const result = aggregateContributions([
      contribution({
        slotId: 1,
        recipeId: 10,
        recipeName: 'Curry',
        scaledQuantity: '1.500',
      }),
      contribution({
        slotId: 2,
        slotDate: '2026-01-02',
        recipeId: 11,
        recipeName: 'Stew',
        scaledQuantity: '0.750',
      }),
    ]);

    const line = result[0]?.lines[0];
    expect(line?.totalQuantity).toBe('2.250');
    expect(line?.contributingSlots).toHaveLength(2);
    expect(line?.contributingSlots.map((c) => c.recipeName)).toEqual([
      'Curry',
      'Stew',
    ]);
  });

  it('collapses within-slot duplicate lines from the same recipe', () => {
    // "1 onion sliced" + "1 onion diced" under one slot → one contributing
    // slot with quantity 2.000.
    const result = aggregateContributions([
      contribution({ scaledQuantity: '1.000' }),
      contribution({ scaledQuantity: '1.000' }),
    ]);

    const line = result[0]?.lines[0];
    expect(line?.totalQuantity).toBe('2.000');
    expect(line?.contributingSlots).toHaveLength(1);
    expect(line?.contributingSlots[0]?.scaledQuantity).toBe('2.000');
  });

  it('keeps separate entries when the same slot contributes via two recipes', () => {
    // Slot 5 eats batch-version Recipe A (recipeId=10) and cooks base B
    // (recipeId=20); both contain ingredient onion. Two contributing slots,
    // one ingredient line, total summed.
    const result = aggregateContributions([
      contribution({
        slotId: 5,
        recipeId: 10,
        recipeName: 'Chickpea bowls',
        scaledQuantity: '1.000',
      }),
      contribution({
        slotId: 5,
        recipeId: 20,
        recipeName: 'Curry base',
        scaledQuantity: '2.000',
      }),
    ]);

    const line = result[0]?.lines[0];
    expect(line?.totalQuantity).toBe('3.000');
    expect(line?.contributingSlots).toHaveLength(2);
    expect(line?.contributingSlots.map((c) => c.recipeId).sort()).toEqual([
      10, 20,
    ]);
  });

  it('groups ingredients by category and sorts by category then name', () => {
    const result = aggregateContributions([
      contribution({
        ingredientId: 3,
        ingredientName: 'Tomato',
        categoryId: 1,
        categoryName: 'Produce',
      }),
      contribution({
        ingredientId: 1,
        ingredientName: 'Onion',
        categoryId: 1,
        categoryName: 'Produce',
      }),
      contribution({
        ingredientId: 2,
        ingredientName: 'Chicken',
        categoryId: 2,
        categoryName: 'Meat',
      }),
    ]);

    expect(result.map((c) => c.category.name)).toEqual(['Meat', 'Produce']);
    expect(result[1]?.lines.map((l) => l.ingredient.name)).toEqual([
      'Onion',
      'Tomato',
    ]);
  });

  it('sorts contributingSlots by date then slotId', () => {
    const result = aggregateContributions([
      contribution({
        slotId: 9,
        slotDate: '2026-01-03',
        recipeId: 90,
        recipeName: 'C',
      }),
      contribution({
        slotId: 2,
        slotDate: '2026-01-01',
        recipeId: 20,
        recipeName: 'A',
      }),
      contribution({
        slotId: 1,
        slotDate: '2026-01-02',
        recipeId: 10,
        recipeName: 'B',
      }),
    ]);

    expect(
      result[0]?.lines[0]?.contributingSlots.map((c) => c.recipeName),
    ).toEqual(['A', 'B', 'C']);
  });

  it('sums precise fractional quantities without float drift', () => {
    // 0.1 + 0.2 in IEEE-754 floats is 0.30000000000000004; the helper sums
    // integer milli so the answer is exactly 0.300.
    const result = aggregateContributions([
      contribution({ slotId: 1, scaledQuantity: '0.100' }),
      contribution({
        slotId: 2,
        slotDate: '2026-01-02',
        scaledQuantity: '0.200',
      }),
    ]);

    expect(result[0]?.lines[0]?.totalQuantity).toBe('0.300');
  });

  it('parses scaled quantities with and without decimals', () => {
    const result = aggregateContributions([
      contribution({ slotId: 1, scaledQuantity: '12' }),
      contribution({
        slotId: 2,
        slotDate: '2026-01-02',
        scaledQuantity: '0.001',
      }),
    ]);
    expect(result[0]?.lines[0]?.totalQuantity).toBe('12.001');
  });
});
