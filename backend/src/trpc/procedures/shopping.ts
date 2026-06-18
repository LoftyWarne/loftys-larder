import { TRPCError } from '@trpc/server';
import { and, eq, sql } from 'drizzle-orm';

import {
  getShoppingListForPlanInputSchema,
  getShoppingListForPlanResultSchema,
  type GetShoppingListForPlanResult,
} from '../../../../shared/src/index.ts';
import { CURRENT_HOUSEHOLD_ID } from '../../config.ts';
import type { Db } from '../../db/index.ts';
import { ingredients } from '../../db/schema/ingredients.ts';
import { mealPlans, mealPlanSlots } from '../../db/schema/meal-plans.ts';
import {
  ingredientCategories,
  unitsOfMeasurement,
} from '../../db/schema/reference.ts';
import { recipeIngredients, recipes } from '../../db/schema/recipes.ts';
import { formatCivilDate } from '../../lib/date-utils.ts';
import {
  aggregateContributions,
  type ShoppingContribution,
} from '../../lib/shopping-aggregation.ts';
import { protectedProcedure, router } from '../init.ts';

export const shoppingRouter = router({
  getForPlan: protectedProcedure
    .input(getShoppingListForPlanInputSchema)
    .output(getShoppingListForPlanResultSchema)
    .query(async ({ ctx, input }): Promise<GetShoppingListForPlanResult> => {
      // Plan-existence + household scope are enforced by this preflight read;
      // both contribution queries below then trust the planId. A single
      // round-trip mismatch surfaces as NOT_FOUND, mirroring `plans.get`.
      const planRow = await loadHouseholdPlan(ctx.db, input.planId);

      const [mealContribs, baseContribs] = await Promise.all([
        selectMealRecipeContributions(ctx.db, planRow.id),
        selectCooksBaseContributions(ctx.db, planRow.id),
      ]);

      const categories = aggregateContributions([
        ...mealContribs,
        ...baseContribs,
      ]);
      return { planId: planRow.id, categories };
    }),
});

interface PlanRow {
  id: number;
}

async function loadHouseholdPlan(db: Db, id: number): Promise<PlanRow> {
  const rows = await db
    .select({ id: mealPlans.id })
    .from(mealPlans)
    .where(
      and(
        eq(mealPlans.id, id),
        eq(mealPlans.householdId, CURRENT_HOUSEHOLD_ID),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Plan not found' });
  }
  return row;
}

// Meal-recipe contribution rows: one row per (slot, recipe_ingredients line)
// for every slot whose `slot_type = 'recipe'`. The eating recipe is joined
// without an `is_deleted` filter — historical plans whose recipe was
// soft-deleted after assignment still aggregate correctly (DEC-21 / DEC-22).
// A batch-version meal (`recipe.base_recipe_id IS NOT NULL`) contributes
// only its own ingredient rows here — the base's ingredients flow through
// the cooks-base path, never the meal path, which is the no-double-count
// invariant.
async function selectMealRecipeContributions(
  db: Db,
  planId: number,
): Promise<ShoppingContribution[]> {
  const rows = await db
    .select({
      slotId: mealPlanSlots.id,
      slotDate: mealPlanSlots.date,
      recipeId: recipes.id,
      recipeName: recipes.name,
      ingredientId: ingredients.id,
      ingredientName: ingredients.name,
      categoryId: ingredientCategories.id,
      categoryName: ingredientCategories.name,
      unitId: unitsOfMeasurement.id,
      unitName: unitsOfMeasurement.name,
      // numeric arithmetic preserves precision; round to the column's
      // numeric(10,3) scale so the helper's integer-milli math is exact.
      scaledQuantity: sql<string>`round(${recipeIngredients.quantity} * ${mealPlanSlots.numberOfServings}::numeric / ${recipes.baseServings}::numeric, 3)`,
    })
    .from(mealPlanSlots)
    .innerJoin(mealPlans, eq(mealPlans.id, mealPlanSlots.planId))
    .innerJoin(recipes, eq(recipes.id, mealPlanSlots.recipeId))
    .innerJoin(recipeIngredients, eq(recipeIngredients.recipeId, recipes.id))
    .innerJoin(ingredients, eq(ingredients.id, recipeIngredients.ingredientId))
    .innerJoin(
      ingredientCategories,
      eq(ingredientCategories.id, ingredients.categoryId),
    )
    .innerJoin(
      unitsOfMeasurement,
      eq(unitsOfMeasurement.id, ingredients.defaultUnitId),
    )
    .where(
      and(
        eq(mealPlans.id, planId),
        eq(mealPlans.householdId, CURRENT_HOUSEHOLD_ID),
        eq(mealPlanSlots.slotType, 'recipe'),
      ),
    );

  return rows.map(toContribution);
}

// Cooks-base contribution rows: one row per (slot, base_recipe_ingredients
// line) for every slot whose `cooks_base_recipe_id` is set. The base recipe
// is joined without an `is_deleted` filter for the same DEC-21/22 reason.
// Per DEC-26 we don't warn on missing base supply — we just sum what's set.
async function selectCooksBaseContributions(
  db: Db,
  planId: number,
): Promise<ShoppingContribution[]> {
  const rows = await db
    .select({
      slotId: mealPlanSlots.id,
      slotDate: mealPlanSlots.date,
      recipeId: recipes.id,
      recipeName: recipes.name,
      ingredientId: ingredients.id,
      ingredientName: ingredients.name,
      categoryId: ingredientCategories.id,
      categoryName: ingredientCategories.name,
      unitId: unitsOfMeasurement.id,
      unitName: unitsOfMeasurement.name,
      scaledQuantity: sql<string>`round(${recipeIngredients.quantity} * ${mealPlanSlots.cooksBaseServings}::numeric / ${recipes.baseServings}::numeric, 3)`,
    })
    .from(mealPlanSlots)
    .innerJoin(mealPlans, eq(mealPlans.id, mealPlanSlots.planId))
    .innerJoin(recipes, eq(recipes.id, mealPlanSlots.cooksBaseRecipeId))
    .innerJoin(recipeIngredients, eq(recipeIngredients.recipeId, recipes.id))
    .innerJoin(ingredients, eq(ingredients.id, recipeIngredients.ingredientId))
    .innerJoin(
      ingredientCategories,
      eq(ingredientCategories.id, ingredients.categoryId),
    )
    .innerJoin(
      unitsOfMeasurement,
      eq(unitsOfMeasurement.id, ingredients.defaultUnitId),
    )
    .where(
      and(
        eq(mealPlans.id, planId),
        eq(mealPlans.householdId, CURRENT_HOUSEHOLD_ID),
        sql`${mealPlanSlots.cooksBaseRecipeId} IS NOT NULL`,
      ),
    );

  return rows.map(toContribution);
}

interface ContributionRow {
  slotId: number;
  slotDate: Date;
  recipeId: number;
  recipeName: string;
  ingredientId: number;
  ingredientName: string;
  categoryId: number;
  categoryName: string;
  unitId: number;
  unitName: string;
  scaledQuantity: string;
}

function toContribution(row: ContributionRow): ShoppingContribution {
  return {
    slotId: row.slotId,
    slotDate: formatCivilDate(row.slotDate),
    recipeId: row.recipeId,
    recipeName: row.recipeName,
    ingredientId: row.ingredientId,
    ingredientName: row.ingredientName,
    categoryId: row.categoryId,
    categoryName: row.categoryName,
    unitId: row.unitId,
    unitName: row.unitName,
    scaledQuantity: row.scaledQuantity,
  };
}
