import { asc, eq, inArray } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { PlanSlotItem } from '../../../shared/src/index.ts';
import * as schema from '../db/schema/index.ts';
import { mealPlanSlotItems } from '../db/schema/meal-plans.ts';
import { recipes } from '../db/schema/recipes.ts';
import type { Tx } from '../db/withTransaction.ts';

type DbHandle = NodePgDatabase<typeof schema> | Tx;

// Loads the dishes for a set of slots, joined to `recipes` for the denormalised
// fields the planner renders + the balance needs (`isBase`/`baseRecipeId`).
// Ordered by `(slot, sort_order, id)` so each slot's items come back stable.
// Returned as a map keyed by slot id; slots with no items are simply absent.
export async function loadSlotItems(
  db: DbHandle,
  slotIds: readonly number[],
): Promise<Map<number, PlanSlotItem[]>> {
  const bySlot = new Map<number, PlanSlotItem[]>();
  if (slotIds.length === 0) return bySlot;

  const rows = await db
    .select({
      slotId: mealPlanSlotItems.slotId,
      id: mealPlanSlotItems.id,
      recipeId: mealPlanSlotItems.recipeId,
      servings: mealPlanSlotItems.servings,
      kind: mealPlanSlotItems.kind,
      sortOrder: mealPlanSlotItems.sortOrder,
      recipeName: recipes.name,
      recipeImageUrl: recipes.imageUrl,
      isBase: recipes.isBase,
      baseRecipeId: recipes.baseRecipeId,
      isDeleted: recipes.isDeleted,
    })
    .from(mealPlanSlotItems)
    .innerJoin(recipes, eq(mealPlanSlotItems.recipeId, recipes.id))
    .where(inArray(mealPlanSlotItems.slotId, [...slotIds]))
    .orderBy(
      asc(mealPlanSlotItems.slotId),
      asc(mealPlanSlotItems.sortOrder),
      asc(mealPlanSlotItems.id),
    );

  for (const row of rows) {
    const item: PlanSlotItem = {
      id: row.id,
      recipeId: row.recipeId,
      recipeName: row.recipeName,
      recipeImageUrl: row.recipeImageUrl,
      isBase: row.isBase,
      baseRecipeId: row.baseRecipeId,
      isDeleted: row.isDeleted,
      servings: row.servings,
      kind: row.kind,
      sortOrder: row.sortOrder,
    };
    const list = bySlot.get(row.slotId);
    if (list) list.push(item);
    else bySlot.set(row.slotId, [item]);
  }
  return bySlot;
}
