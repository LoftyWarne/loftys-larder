import { describe, expect, it } from 'vitest';

import {
  aggregateContributions,
  type ShoppingContribution,
} from '../src/lib/shopping-aggregation.ts';

// Pure-helper tests for the shopping aggregation math. The procedure feeds
// SQL-scaled numeric(10,3) strings in; the helper groups, sums, and orders.
// No DB — every input row is fabricated.

// Default `planStart` for tests that don't care about shelf life. Far enough
// in the past that no realistic shelf life would push usage past the boundary
// — slot dates around 2026-01-01 with a default `averageShelfLifeDays: null`
// keeps every existing case warning-free.
const DEFAULT_PLAN_START = new Date(Date.UTC(2025, 11, 25));

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
    averageShelfLifeDays: null,
    ...overrides,
  };
}

function civilDate(iso: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) throw new Error(`civilDate: bad ISO ${iso}`);
  return new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
  );
}

describe('aggregateContributions', () => {
  it('returns no categories for empty input', () => {
    expect(
      aggregateContributions([], { planStart: DEFAULT_PLAN_START }),
    ).toEqual([]);
  });

  it('produces one line per ingredient with one contributing slot', () => {
    const result = aggregateContributions(
      [contribution({ scaledQuantity: '2.000' })],
      { planStart: DEFAULT_PLAN_START },
    );

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
    const result = aggregateContributions(
      [
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
      ],
      { planStart: DEFAULT_PLAN_START },
    );

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
    const result = aggregateContributions(
      [
        contribution({ scaledQuantity: '1.000' }),
        contribution({ scaledQuantity: '1.000' }),
      ],
      { planStart: DEFAULT_PLAN_START },
    );

    const line = result[0]?.lines[0];
    expect(line?.totalQuantity).toBe('2.000');
    expect(line?.contributingSlots).toHaveLength(1);
    expect(line?.contributingSlots[0]?.scaledQuantity).toBe('2.000');
  });

  it('keeps separate entries when the same slot contributes via two recipes', () => {
    // Slot 5 eats batch-version Recipe A (recipeId=10) and cooks base B
    // (recipeId=20); both contain ingredient onion. Two contributing slots,
    // one ingredient line, total summed.
    const result = aggregateContributions(
      [
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
      ],
      { planStart: DEFAULT_PLAN_START },
    );

    const line = result[0]?.lines[0];
    expect(line?.totalQuantity).toBe('3.000');
    expect(line?.contributingSlots).toHaveLength(2);
    expect(line?.contributingSlots.map((c) => c.recipeId).sort()).toEqual([
      10, 20,
    ]);
  });

  it('groups ingredients by category and sorts by category then name', () => {
    const result = aggregateContributions(
      [
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
      ],
      { planStart: DEFAULT_PLAN_START },
    );

    expect(result.map((c) => c.category.name)).toEqual(['Meat', 'Produce']);
    expect(result[1]?.lines.map((l) => l.ingredient.name)).toEqual([
      'Onion',
      'Tomato',
    ]);
  });

  it('sorts contributingSlots by date then slotId', () => {
    const result = aggregateContributions(
      [
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
      ],
      { planStart: DEFAULT_PLAN_START },
    );

    expect(
      result[0]?.lines[0]?.contributingSlots.map((c) => c.recipeName),
    ).toEqual(['A', 'B', 'C']);
  });

  it('sums precise fractional quantities without float drift', () => {
    // 0.1 + 0.2 in IEEE-754 floats is 0.30000000000000004; the helper sums
    // integer milli so the answer is exactly 0.300.
    const result = aggregateContributions(
      [
        contribution({ slotId: 1, scaledQuantity: '0.100' }),
        contribution({
          slotId: 2,
          slotDate: '2026-01-02',
          scaledQuantity: '0.200',
        }),
      ],
      { planStart: DEFAULT_PLAN_START },
    );

    expect(result[0]?.lines[0]?.totalQuantity).toBe('0.300');
  });

  it('parses scaled quantities with and without decimals', () => {
    const result = aggregateContributions(
      [
        contribution({ slotId: 1, scaledQuantity: '12' }),
        contribution({
          slotId: 2,
          slotDate: '2026-01-02',
          scaledQuantity: '0.001',
        }),
      ],
      { planStart: DEFAULT_PLAN_START },
    );
    expect(result[0]?.lines[0]?.totalQuantity).toBe('12.001');
  });
});

describe('aggregateContributions shelf-life warning', () => {
  // Anchor every case to a single plan start: 2026-06-01. The boundary
  // for a 3-day shelf life is 2026-06-04 (last good day); a slot on
  // 2026-06-05 is one day past.
  const PLAN_START = civilDate('2026-06-01');

  it('flags a line when one contributing slot lands past the shelf-life boundary', () => {
    const result = aggregateContributions(
      [
        contribution({
          slotDate: '2026-06-05',
          averageShelfLifeDays: 3,
        }),
      ],
      { planStart: PLAN_START },
    );

    expect(result[0]?.lines[0]?.shelfLifeWarning).toEqual({
      latestNeededDate: '2026-06-05',
      daysOverflow: 1,
    });
  });

  it('does not warn when the latest slot lands exactly on the boundary', () => {
    // 3-day shelf life, planStart=2026-06-01 → boundary 2026-06-04.
    // A slot on that day is treated as fitting.
    const result = aggregateContributions(
      [
        contribution({
          slotDate: '2026-06-04',
          averageShelfLifeDays: 3,
        }),
      ],
      { planStart: PLAN_START },
    );

    expect(result[0]?.lines[0]?.shelfLifeWarning).toBeUndefined();
  });

  it('does not warn when averageShelfLifeDays is null, even when usage is far in the future', () => {
    const result = aggregateContributions(
      [
        contribution({
          slotDate: '2026-12-31',
          averageShelfLifeDays: null,
        }),
      ],
      { planStart: PLAN_START },
    );

    expect(result[0]?.lines[0]?.shelfLifeWarning).toBeUndefined();
  });

  it('uses the maximum contributing-slot date as latestNeededDate', () => {
    const result = aggregateContributions(
      [
        contribution({
          slotId: 1,
          slotDate: '2026-06-02',
          averageShelfLifeDays: 3,
        }),
        contribution({
          slotId: 2,
          slotDate: '2026-06-09',
          averageShelfLifeDays: 3,
        }),
        contribution({
          slotId: 3,
          slotDate: '2026-06-07',
          averageShelfLifeDays: 3,
        }),
      ],
      { planStart: PLAN_START },
    );

    expect(result[0]?.lines[0]?.shelfLifeWarning).toEqual({
      latestNeededDate: '2026-06-09',
      daysOverflow: 5,
    });
  });

  it('omits the field (not null) when the line fits within shelf life', () => {
    const result = aggregateContributions(
      [
        contribution({
          slotDate: '2026-06-03',
          averageShelfLifeDays: 3,
        }),
      ],
      { planStart: PLAN_START },
    );

    const line = result[0]?.lines[0];
    expect(line?.shelfLifeWarning).toBeUndefined();
    expect(line && 'shelfLifeWarning' in line).toBe(false);
  });

  it('flags each ingredient independently', () => {
    // Coriander: short shelf life, used late → warns.
    // Onion: short shelf life, used inside boundary → no warning.
    const result = aggregateContributions(
      [
        contribution({
          slotId: 1,
          slotDate: '2026-06-06',
          ingredientId: 10,
          ingredientName: 'Coriander',
          averageShelfLifeDays: 3,
        }),
        contribution({
          slotId: 2,
          slotDate: '2026-06-03',
          ingredientId: 11,
          ingredientName: 'Onion',
          averageShelfLifeDays: 3,
        }),
      ],
      { planStart: PLAN_START },
    );

    const lines = result[0]?.lines;
    const coriander = lines?.find((l) => l.ingredient.name === 'Coriander');
    const onion = lines?.find((l) => l.ingredient.name === 'Onion');
    expect(coriander?.shelfLifeWarning).toEqual({
      latestNeededDate: '2026-06-06',
      daysOverflow: 2,
    });
    expect(onion?.shelfLifeWarning).toBeUndefined();
  });
});
