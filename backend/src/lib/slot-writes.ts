import { TRPCError } from '@trpc/server';
import { and, eq, inArray } from 'drizzle-orm';

import type { SlotItemInput } from '../../../shared/src/index.ts';
import type { Db } from '../db/index.ts';
import { users } from '../db/schema/auth.ts';
import {
  mealPlanSlotDiners,
  mealPlanSlotItems,
} from '../db/schema/meal-plans.ts';
import { recipes } from '../db/schema/recipes.ts';
import type { Tx } from '../db/withTransaction.ts';

import { pickableRecipesWhere } from './pickable-recipes.ts';

// Writing a slot's dishes and diners, shared by the slot editor, slot
// relocation and Apply (DEC-117), so every path writes them the same way.

// Replace the slot's items with `items`, reinserting in the given order. The
// caller is responsible for having deleted any prior rows (relocate batches the
// delete across both slots; update relies on this helper's own delete).
export async function replaceSlotItems(
  tx: Tx,
  slotId: number,
  items: readonly SlotItemInput[],
): Promise<void> {
  await tx
    .delete(mealPlanSlotItems)
    .where(eq(mealPlanSlotItems.slotId, slotId));
  if (items.length === 0) return;
  await tx.insert(mealPlanSlotItems).values(
    items.map((item) => ({
      slotId,
      recipeId: item.recipeId,
      prepared: item.prepared,
      eaten: item.eaten,
      sortOrder: item.sortOrder,
    })),
  );
}

// Replace the slot's named diners with `userIds`. Like `replaceSlotItems`, the
// caller may have batch-deleted prior rows already (relocate does); this helper
// also clears the slot's own rows so `update` can call it standalone.
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
