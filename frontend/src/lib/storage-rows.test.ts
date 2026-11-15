import type { StockItem, StockTarget } from '@loftys-larder/shared';
import { describe, expect, it } from 'vitest';

import {
  formatRowAmount,
  formatStockAge,
  formatUseBy,
  groupStorage,
  isPastUseBy,
  stepEdit,
  type StorageRow,
} from './storage-rows.ts';

const cod: StockTarget = {
  kind: 'ingredient',
  ingredientId: 1,
  name: 'Cod',
  unitName: 'g',
  averageShelfLifeDays: null,
};
const chicken: StockTarget = {
  kind: 'ingredient',
  ingredientId: 2,
  name: 'Chicken Thigh',
  unitName: 'g',
  averageShelfLifeDays: 2,
};
const stew: StockTarget = {
  kind: 'recipe',
  recipeId: 9,
  name: 'Beef Stew Base',
  isBase: true,
  isDeleted: false,
};

function only(rows: StorageRow[]): StorageRow {
  const [row] = rows;
  if (!row) throw new Error('no row');
  return row;
}

let nextId = 1;
function item(
  overrides: Partial<StockItem> & { target: StockTarget },
): StockItem {
  nextId += 1;
  return {
    id: nextId,
    location: 'freezer',
    quantity: '500.000',
    reserved: '0.000',
    addedOn: '2026-11-01',
    useBy: null,
    ...overrides,
  };
}

describe('groupStorage', () => {
  it('combines Freezer items of one ingredient into one row, with the total and the oldest date', () => {
    const items = [
      item({ target: cod, quantity: '500.000', addedOn: '2026-11-08' }),
      item({ target: cod, quantity: '300.000', addedOn: '2026-11-01' }),
      item({ target: stew, quantity: '2.000' }),
      item({ target: cod, location: 'pantry' }),
    ];
    const { ingredients, dishes } = groupStorage(items, 'freezer');
    expect(ingredients).toHaveLength(1);
    expect(ingredients[0]?.totalMilli).toBe(800_000);
    expect(ingredients[0]?.oldestAddedOn).toBe('2026-11-01');
    expect(ingredients[0]?.items.map((i) => i.addedOn)).toEqual([
      '2026-11-01',
      '2026-11-08',
    ]);
    expect(dishes).toHaveLength(1);
    expect(formatRowAmount(only(ingredients))).toBe('800 g');
  });

  it('never combines Fridge items, and sorts them by soonest Use-by with blanks last', () => {
    const items = [
      item({ target: cod, location: 'fridge', useBy: null }),
      item({ target: chicken, location: 'fridge', useBy: '2026-11-20' }),
      item({ target: chicken, location: 'fridge', useBy: '2026-11-17' }),
    ];
    const { ingredients } = groupStorage(items, 'fridge');
    expect(ingredients.map((row) => row.useBy)).toEqual([
      '2026-11-17',
      '2026-11-20',
      null,
    ]);
  });

  it('shows what’s reserved', () => {
    const { dishes } = groupStorage(
      [item({ target: stew, quantity: '2.000', reserved: '1.000' })],
      'freezer',
    );
    expect(formatRowAmount(only(dishes))).toBe('2 portions, 1 reserved');
  });
});

describe('formatStockAge', () => {
  it('says frozen in the Freezer and added elsewhere', () => {
    expect(formatStockAge('2026-10-04', '2026-11-15', 'freezer')).toBe(
      'frozen 6 weeks ago',
    );
    expect(formatStockAge('2026-11-15', '2026-11-15', 'pantry')).toBe(
      'added today',
    );
    expect(formatStockAge('2026-11-14', '2026-11-15', 'fridge')).toBe(
      'added yesterday',
    );
    expect(formatStockAge('2026-11-05', '2026-11-15', 'fridge')).toBe(
      'added 10 days ago',
    );
    expect(formatStockAge('2026-06-01', '2026-11-15', 'freezer')).toBe(
      'frozen 5 months ago',
    );
  });
});

describe('formatUseBy', () => {
  // 2026-11-15 is a Sunday.
  it('names the weekday within a week, the date after, and marks a past one', () => {
    expect(formatUseBy('2026-11-15', '2026-11-15')).toBe('use by today');
    expect(formatUseBy('2026-11-16', '2026-11-15')).toBe('use by tomorrow');
    expect(formatUseBy('2026-11-19', '2026-11-15')).toBe('use by Thu');
    expect(formatUseBy('2026-12-03', '2026-11-15')).toBe('use by 3 Dec');
    expect(formatUseBy('2026-11-14', '2026-11-15')).toBe('past use-by');
    expect(isPastUseBy('2026-11-14', '2026-11-15')).toBe(true);
    expect(isPastUseBy(null, '2026-11-15')).toBe(false);
  });
});

describe('stepEdit', () => {
  it('steps portions by one and grams by 50, on the newest item', () => {
    const { ingredients, dishes } = groupStorage(
      [
        item({ target: cod, quantity: '500.000', addedOn: '2026-11-01' }),
        item({ target: cod, quantity: '30.000', addedOn: '2026-11-10' }),
        item({ target: stew, quantity: '2.000' }),
      ],
      'freezer',
    );
    const codRow = ingredients[0];
    const stewRow = dishes[0];
    if (!codRow || !stewRow) throw new Error('rows missing');
    expect(stepEdit(stewRow, -1)?.quantity).toBe('1.000');
    expect(stepEdit(codRow, 1)).toEqual({
      id: codRow.items[1]?.id,
      quantity: '80.000',
    });
    expect(stepEdit(codRow, -1)?.quantity).toBe('0.000');
  });
  it('lowers the newest item with some of it free, and the newest when all is reserved', () => {
    const free = item({ target: cod, addedOn: '2026-11-01' });
    const held = item({
      target: cod,
      addedOn: '2026-11-10',
      reserved: '500.000',
    });
    const row = only(groupStorage([free, held], 'freezer').ingredients);
    expect(stepEdit(row, -1)).toEqual({ id: free.id, quantity: '450.000' });
    expect(stepEdit(row, 1)).toEqual({ id: held.id, quantity: '550.000' });

    const allHeld = only(
      groupStorage([{ ...free, reserved: '500.000' }, held], 'freezer')
        .ingredients,
    );
    expect(stepEdit(allHeld, -1)).toEqual({
      id: held.id,
      quantity: '450.000',
    });
  });
});
