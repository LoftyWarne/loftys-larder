import { TRPCError } from '@trpc/server';
import { and, asc, eq, inArray } from 'drizzle-orm';

import type { SlotItemInput, StoredLimit } from '../../../shared/src/index.ts';
import { CURRENT_HOUSEHOLD_ID } from '../config.ts';
import type { Db } from '../db/index.ts';
import { users } from '../db/schema/auth.ts';
import {
  mealPlanSlotDiners,
  mealPlanSlotItems,
} from '../db/schema/meal-plans.ts';
import { recipes } from '../db/schema/recipes.ts';
import type { Tx } from '../db/withTransaction.ts';

import { pickableRecipesWhere } from './pickable-recipes.ts';
import { changeStored } from './slot-storing.ts';
import { settleReservations } from './stock-settlement.ts';

// Writing a slot's dishes and diners, shared by the slot editor, slot
// relocation and Apply (DEC-117), so every path writes them the same way.
//
// A slot item's id is kept for as long as the dish stays on its slot, because
// Stock items stored from it (FEAT-79) and Reservations made by it (DEC-118)
// point at that id. So the editor's save updates matching rows in place and a
// relocate moves rows between slots; only a dish added or removed is inserted
// or deleted.

// Insert dishes into a slot that has none yet (a new plan's slot). Nothing is
// stored from a dish that has just been made.
// Returns each dish's new id by recipe.
export async function insertSlotItems(
  tx: Tx,
  slotId: number,
  items: readonly SlotItemInput[],
): Promise<Map<number, number>> {
  const ids = new Map<number, number>();
  if (items.length === 0) return ids;
  const rows = await tx
    .insert(mealPlanSlotItems)
    .values(
      items.map((item) => ({
        slotId,
        recipeId: item.recipeId,
        prepared: item.prepared,
        eaten: item.eaten,
        fromStorage: item.fromStorage ?? 0,
        sortOrder: item.sortOrder,
      })),
    )
    .returning({
      id: mealPlanSlotItems.id,
      recipeId: mealPlanSlotItems.recipeId,
    });
  for (const row of rows) ids.set(row.recipeId, row.id);
  return ids;
}

// Make the slot's dishes match `items`. Each incoming dish takes over the
// existing row for the same recipe (the editor holds a recipe once per slot),
// keeping its id and its Fridge count. A dish's `frozen`, when given, moves
// its Freezer stock with it (FEAT-79); a lowered count that can't all be taken
// back is reported in the result. Rows no incoming dish matches are deleted,
// and Stock items stored from them stay, unlinked; their Reservations go with
// them. Returns the limits and each dish's id by recipe.
export async function reconcileSlotItems(
  tx: Tx,
  slotId: number,
  items: readonly SlotItemInput[],
  today: Date,
): Promise<{ limits: StoredLimit[]; itemIds: Map<number, number> }> {
  const existing = await tx
    .select({
      id: mealPlanSlotItems.id,
      recipeId: mealPlanSlotItems.recipeId,
      frozen: mealPlanSlotItems.frozen,
      chilled: mealPlanSlotItems.chilled,
    })
    .from(mealPlanSlotItems)
    .where(eq(mealPlanSlotItems.slotId, slotId))
    .orderBy(asc(mealPlanSlotItems.id))
    .for('update');
  const unmatched = new Map<number, (typeof existing)[number]>();
  for (const row of existing) {
    if (!unmatched.has(row.recipeId)) unmatched.set(row.recipeId, row);
  }
  const keptIds = new Set<number>();
  const itemIds = new Map<number, number>();
  const limits: StoredLimit[] = [];
  let settled = false;

  for (const item of items) {
    const match = unmatched.get(item.recipeId);
    if (!match) {
      const frozen = item.frozen ?? 0;
      const [inserted] = await tx
        .insert(mealPlanSlotItems)
        .values({
          slotId,
          recipeId: item.recipeId,
          prepared: item.prepared,
          eaten: item.eaten,
          frozen,
          fromStorage: item.fromStorage ?? 0,
          sortOrder: item.sortOrder,
        })
        .returning({ id: mealPlanSlotItems.id });
      if (inserted) itemIds.set(item.recipeId, inserted.id);
      if (inserted && frozen > 0) {
        await changeStored(
          tx,
          {
            slotItemId: inserted.id,
            recipeId: item.recipeId,
            location: 'freezer',
            from: 0,
            to: frozen,
          },
          today,
        );
      }
      continue;
    }
    unmatched.delete(item.recipeId);
    keptIds.add(match.id);
    itemIds.set(item.recipeId, match.id);

    const wanted = item.frozen ?? match.frozen;
    if (wanted < match.frozen && !settled) {
      await settleReservations(tx, today);
      settled = true;
    }
    const frozen = await changeStored(
      tx,
      {
        slotItemId: match.id,
        recipeId: item.recipeId,
        location: 'freezer',
        from: match.frozen,
        to: wanted,
      },
      today,
    );
    if (frozen !== wanted) {
      limits.push({
        slotItemId: match.id,
        location: 'freezer',
        requested: wanted,
        applied: frozen,
      });
    }
    assertStoredFits(item, frozen, match.chilled);
    await tx
      .update(mealPlanSlotItems)
      .set({
        prepared: item.prepared,
        eaten: item.eaten,
        frozen,
        fromStorage: item.fromStorage ?? 0,
        sortOrder: item.sortOrder,
      })
      .where(eq(mealPlanSlotItems.id, match.id));
  }

  const removed = existing
    .filter((row) => !keptIds.has(row.id))
    .map((row) => row.id);
  if (removed.length > 0) {
    await tx
      .delete(mealPlanSlotItems)
      .where(inArray(mealPlanSlotItems.id, removed));
  }
  return { limits, itemIds };
}

// Stored portions that can't be taken back still count against what was
// prepared, so a lower Prepare has to leave room for them.
function assertStoredFits(
  item: SlotItemInput,
  frozen: number,
  chilled: number,
): void {
  if (frozen + chilled === 0) return;
  if (item.eaten + frozen + chilled <= item.prepared) return;
  throw new TRPCError({
    code: 'BAD_REQUEST',
    message: 'Stored portions are more than this leaves prepared',
    cause: {
      code: 'SLOT_ITEM_STORED_EXCEEDS_PREPARED',
      recipeId: item.recipeId,
      frozen,
      chilled,
    },
  });
}

// Move dishes to another slot, keeping their ids (slot relocation).
export async function moveSlotItems(
  tx: Tx,
  itemIds: readonly number[],
  toSlotId: number,
): Promise<void> {
  if (itemIds.length === 0) return;
  await tx
    .update(mealPlanSlotItems)
    .set({ slotId: toSlotId })
    .where(inArray(mealPlanSlotItems.id, [...itemIds]));
}

// Replace the slot's named diners with `userIds`. The caller may have
// batch-deleted prior rows already (relocate does); this helper also clears
// the slot's own rows so `update` can call it standalone.
export async function replaceSlotDiners(
  tx: Tx,
  slotId: number,
  userIds: readonly string[],
): Promise<void> {
  await tx
    .delete(mealPlanSlotDiners)
    .where(eq(mealPlanSlotDiners.slotId, slotId));
  if (userIds.length === 0) return;
  await tx
    .insert(mealPlanSlotDiners)
    .values(userIds.map((userId) => ({ slotId, userId })));
}

// Every recipe a new plan's slots name is pickable now (cross-cutting #5),
// including the picker's rule for variations of a deleted base.
export async function assertRecipesPickable(
  db: Db | Tx,
  recipeIds: readonly number[],
): Promise<void> {
  const ids = [...new Set(recipeIds)];
  if (ids.length === 0) return;
  const rows = await db
    .select({ id: recipes.id })
    .from(recipes)
    .where(
      and(
        inArray(recipes.id, ids),
        pickableRecipesWhere({ includePickerHidden: true }),
      ),
    );
  const pickable = new Set(rows.map((row) => row.id));
  const missing = ids.find((id) => !pickable.has(id));
  if (missing !== undefined) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'A recipe is not pickable',
      cause: { code: 'SLOT_RECIPE_NOT_PICKABLE', recipeId: missing },
    });
  }
}

// Leftovers from Storage may eat a soft-deleted recipe's Stock item
// (DEC-118), so its recipe only has to be the household's.
export async function assertRecipesInHousehold(
  db: Db | Tx,
  recipeIds: readonly number[],
): Promise<void> {
  const ids = [...new Set(recipeIds)];
  if (ids.length === 0) return;
  const rows = await db
    .select({ id: recipes.id })
    .from(recipes)
    .where(
      and(
        inArray(recipes.id, ids),
        eq(recipes.householdId, CURRENT_HOUSEHOLD_ID),
      ),
    );
  const found = new Set(rows.map((row) => row.id));
  const missing = ids.find((id) => !found.has(id));
  if (missing !== undefined) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Recipe not available in this household',
      cause: { code: 'SLOT_RECIPE_CROSS_HOUSEHOLD', recipeId: missing },
    });
  }
}

// Diners are checked as the slot editor checks them.
export async function assertDinersExist(
  db: Db | Tx,
  userIds: readonly string[],
): Promise<void> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return;
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(inArray(users.id, ids));
  if (rows.length !== ids.length) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Diner user not found',
      cause: { code: 'SLOT_DINER_NOT_FOUND' },
    });
  }
}
