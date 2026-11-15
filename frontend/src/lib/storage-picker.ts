import type { StockItem, StorageLocation } from '@loftys-larder/shared';

import {
  formatStockAge,
  formatUseBy,
  groupStorage,
  isPastUseBy,
  toMilli,
} from '@/lib/storage-rows.ts';

// What the slot editor offers from storage (FEAT-81): dishes to eat as
// Leftovers from Storage, and a Variation's base. Pure, over `storage.list`.

const LOCATIONS: readonly StorageLocation[] = ['freezer', 'fridge', 'pantry'];

const LOCATION_LABEL: Record<StorageLocation, string> = {
  freezer: 'Freezer',
  fridge: 'Fridge',
  pantry: 'Pantry',
};

export interface StoragePickerEntry {
  // The `<select>` value: `stock:<location>:<row key>`.
  token: string;
  recipeId: number;
  name: string;
  isBase: boolean;
  isDeleted: boolean;
  location: StorageLocation;
  stockItemIds: number[];
  // Portions not yet reserved by anything.
  free: number;
  pastUseBy: boolean;
  label: string;
}

function freeMilli(item: StockItem): number {
  return Math.max(0, toMilli(item.quantity) - toMilli(item.reserved));
}

// Each held dish as the Storage screen groups it: Freezer and Pantry combined
// per dish, Fridge items one by one. Only entries with something free, plus
// any of `keepRecipeId` (the dish the slot already eats), so a saved choice
// can be picked again. Freezer and Fridge entries carry a snowflake; the
// Pantry's don't.
export function dishPickerEntries(
  items: readonly StockItem[],
  today: string,
  keepRecipeId: number | null = null,
): StoragePickerEntry[] {
  return LOCATIONS.flatMap((location) =>
    groupStorage(items, location).dishes.flatMap((row) => {
      const target = row.target;
      if (target.kind !== 'recipe') return [];
      const free = row.items.reduce((sum, item) => sum + freeMilli(item), 0);
      if (free <= 0 && target.recipeId !== keepRecipeId) return [];
      const pastUseBy = isPastUseBy(row.useBy, today);
      const portions = free / 1000;
      const details = [
        LOCATION_LABEL[location],
        formatStockAge(row.oldestAddedOn, today, location),
        ...(location === 'fridge' ? [formatUseBy(row.useBy, today)] : []),
        `${String(portions)} ${portions === 1 ? 'portion' : 'portions'} free`,
      ];
      const snowflake = location === 'pantry' ? '' : '❄ ';
      const deleted = target.isDeleted ? ' (deleted)' : '';
      return [
        {
          token: `stock:${location}:${row.key}`,
          recipeId: target.recipeId,
          name: target.name,
          isBase: target.isBase,
          isDeleted: target.isDeleted,
          location,
          stockItemIds: row.items.map((item) => item.id),
          free: portions,
          pastUseBy,
          label: `${snowflake}${target.name}${deleted} — ${details.join(' · ')}`,
        },
      ];
    }),
  );
}

export interface HeldBase {
  // Free portions in the Freezer and Fridge, past-Use-by Fridge food left out,
  // as the server draws a base.
  free: number;
  // Every free portion is in the Freezer.
  allFrozen: boolean;
}

export function heldBase(
  items: readonly StockItem[],
  baseRecipeId: number,
  today: string,
): HeldBase {
  let freezer = 0;
  let fridge = 0;
  for (const item of items) {
    if (item.target.kind !== 'recipe') continue;
    if (item.target.recipeId !== baseRecipeId) continue;
    if (item.location === 'pantry') continue;
    if (isPastUseBy(item.useBy, today)) continue;
    if (item.location === 'freezer') freezer += freeMilli(item);
    else fridge += freeMilli(item);
  }
  return { free: (freezer + fridge) / 1000, allFrozen: fridge === 0 };
}
