import type { StockItem } from '@loftys-larder/shared';
import { describe, expect, it } from 'vitest';

import { dishPickerEntries, heldBase } from './storage-picker.ts';

const TODAY = '2026-06-10';

let nextId = 1;

function dish(
  overrides: Partial<StockItem> & {
    recipeId?: number;
    name?: string;
    isBase?: boolean;
    isDeleted?: boolean;
  } = {},
): StockItem {
  const {
    recipeId = 10,
    name = 'Lasagne',
    isBase = false,
    isDeleted = false,
    ...rest
  } = overrides;
  return {
    id: nextId++,
    location: 'freezer',
    target: { kind: 'recipe', recipeId, name, isBase, isDeleted },
    quantity: '2.000',
    reserved: '0.000',
    addedOn: '2026-05-20',
    useBy: null,
    ...rest,
  };
}

describe('dishPickerEntries', () => {
  it('combines Freezer items per dish, with a snowflake, location and age', () => {
    const items = [dish(), dish({ quantity: '1.000', addedOn: '2026-06-01' })];
    const [entry] = dishPickerEntries(items, TODAY);
    expect(entry).toMatchObject({
      recipeId: 10,
      location: 'freezer',
      free: 3,
      stockItemIds: items.map((item) => item.id),
    });
    expect(entry?.label).toBe(
      '❄ Lasagne — Freezer · frozen 3 weeks ago · 3 portions free',
    );
  });

  it('lists Fridge items one by one, marking one past its Use-by', () => {
    const entries = dishPickerEntries(
      [
        dish({ location: 'fridge', useBy: '2026-06-12' }),
        dish({ location: 'fridge', useBy: '2026-06-09', quantity: '1.000' }),
      ],
      TODAY,
    );
    expect(entries).toHaveLength(2);
    const past = entries.find((entry) => entry.pastUseBy);
    expect(past?.label).toContain('past use-by');
    expect(past?.label.startsWith('❄ ')).toBe(true);
  });

  it('gives Pantry entries no snowflake', () => {
    const [entry] = dishPickerEntries([dish({ location: 'pantry' })], TODAY);
    expect(entry?.label.startsWith('Lasagne — Pantry')).toBe(true);
  });

  it('shows a soft-deleted recipe’s stock, marked deleted', () => {
    const [entry] = dishPickerEntries([dish({ isDeleted: true })], TODAY);
    expect(entry).toMatchObject({ isDeleted: true });
    expect(entry?.label).toContain('Lasagne (deleted)');
  });

  it('leaves out fully reserved dishes, except the one the slot eats', () => {
    const items = [dish({ reserved: '2.000' })];
    expect(dishPickerEntries(items, TODAY)).toEqual([]);
    expect(dishPickerEntries(items, TODAY, 10)).toHaveLength(1);
  });

  it('leaves out ingredients', () => {
    const ingredient: StockItem = {
      ...dish(),
      target: {
        kind: 'ingredient',
        ingredientId: 3,
        name: 'Spinach',
        unitName: 'g',
        averageShelfLifeDays: null,
      },
    };
    expect(dishPickerEntries([ingredient], TODAY)).toEqual([]);
  });
});

describe('heldBase', () => {
  it('counts free Freezer and Fridge portions, not the Pantry or past Use-by', () => {
    const items = [
      dish({ recipeId: 20, reserved: '1.000' }),
      dish({ recipeId: 20, location: 'fridge', useBy: '2026-06-11' }),
      dish({ recipeId: 20, location: 'fridge', useBy: '2026-06-01' }),
      dish({ recipeId: 20, location: 'pantry' }),
      dish({ recipeId: 21 }),
    ];
    expect(heldBase(items, 20, TODAY)).toEqual({ free: 3, allFrozen: false });
  });

  it('says when all of it is frozen', () => {
    expect(heldBase([dish({ recipeId: 20 })], 20, TODAY)).toEqual({
      free: 2,
      allFrozen: true,
    });
  });
});
