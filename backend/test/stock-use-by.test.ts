import { describe, expect, it } from 'vitest';

import {
  createStockItemInputSchema,
  defaultUseBy,
  isValidPortions,
} from '../../shared/src/index.ts';

describe('defaultUseBy', () => {
  it('adds the ingredient’s average shelf life', () => {
    expect(
      defaultUseBy('2026-11-15', {
        kind: 'ingredient',
        averageShelfLifeDays: 2,
      }),
    ).toBe('2026-11-17');
  });

  it('adds 3 days for cooked portions', () => {
    expect(defaultUseBy('2026-11-30', { kind: 'recipe' })).toBe('2026-12-03');
  });

  it('has no default for an ingredient with no shelf life', () => {
    expect(
      defaultUseBy('2026-11-15', {
        kind: 'ingredient',
        averageShelfLifeDays: null,
      }),
    ).toBeNull();
  });

  it('crosses a year end', () => {
    expect(
      defaultUseBy('2026-12-30', {
        kind: 'ingredient',
        averageShelfLifeDays: 5,
      }),
    ).toBe('2027-01-04');
  });
});

describe('stock item input', () => {
  const base = {
    location: 'freezer' as const,
    target: { kind: 'ingredient' as const, ingredientId: 1 },
    quantity: '500',
    addedOn: '2026-11-15',
  };

  it('accepts an ingredient amount with decimals', () => {
    expect(
      createStockItemInputSchema.safeParse({ ...base, quantity: '0.25' })
        .success,
    ).toBe(true);
  });

  it('refuses a zero amount', () => {
    expect(
      createStockItemInputSchema.safeParse({ ...base, quantity: '0' }).success,
    ).toBe(false);
  });

  it('refuses a Use-by outside the Fridge', () => {
    expect(
      createStockItemInputSchema.safeParse({ ...base, useBy: '2026-11-20' })
        .success,
    ).toBe(false);
    expect(
      createStockItemInputSchema.safeParse({
        ...base,
        location: 'fridge',
        useBy: '2026-11-20',
      }).success,
    ).toBe(true);
  });

  it('takes portions in whole or half', () => {
    expect(isValidPortions('2')).toBe(true);
    expect(isValidPortions('1.5')).toBe(true);
    expect(isValidPortions('1.25')).toBe(false);
    const recipe = { kind: 'recipe' as const, recipeId: 1 };
    expect(
      createStockItemInputSchema.safeParse({
        ...base,
        target: recipe,
        quantity: '1.3',
      }).success,
    ).toBe(false);
  });
});
