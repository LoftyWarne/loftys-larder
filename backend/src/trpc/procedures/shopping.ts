import { TRPCError } from '@trpc/server';
import { and, eq, inArray, sql } from 'drizzle-orm';

import {
  getShoppingListForPlanInputSchema,
  getShoppingListForPlanResultSchema,
  toggleShoppingItemCheckedInputSchema,
  toggleShoppingItemCheckedResultSchema,
  type GetShoppingListForPlanResult,
  type ShoppingListCategory,
  type ToggleShoppingItemCheckedResult,
} from '../../../../shared/src/index.ts';
import { CURRENT_HOUSEHOLD_ID } from '../../config.ts';
import { ingredients } from '../../db/schema/ingredients.ts';
import { mealPlans, mealPlanSlots } from '../../db/schema/meal-plans.ts';
import {
  ingredientCategories,
  unitsOfMeasurement,
} from '../../db/schema/reference.ts';
import { recipeIngredients, recipes } from '../../db/schema/recipes.ts';
import { shoppingListItems } from '../../db/schema/shopping-list.ts';
import { makeWithTransaction, type Tx } from '../../db/withTransaction.ts';
import { formatCivilDate } from '../../lib/date-utils.ts';
import {
  aggregateContributions,
  parseMilliFromFixed3,
  type AggregatedShoppingListCategory,
  type ShoppingContribution,
} from '../../lib/shopping-aggregation.ts';
import { protectedProcedure, router } from '../init.ts';

export const shoppingRouter = router({
  getForPlan: protectedProcedure
    .input(getShoppingListForPlanInputSchema)
    .output(getShoppingListForPlanResultSchema)
    .query(async ({ ctx, input }): Promise<GetShoppingListForPlanResult> => {
      const withTransaction = makeWithTransaction(ctx.db);
      // The aggregation read also writes — lazy-create (DEC-30) and the
      // quantity-bound check-state reset (DEC-31). One transaction keeps
      // concurrent first-reads from racing on the `shopping_list_items`
      // insert (cross-cutting concern #13).
      return await withTransaction(async (tx) => {
        const planRow = await loadHouseholdPlan(tx, input.planId);

        const [mealContribs, baseContribs] = await Promise.all([
          selectMealRecipeContributions(tx, planRow.id),
          selectCooksBaseContributions(tx, planRow.id),
        ]);

        const aggregated = aggregateContributions(
          [...mealContribs, ...baseContribs],
          { planStart: planRow.startDate },
        );

        const lineTotals = collectIngredientTotals(aggregated);
        const checkStates = await reconcileCheckState(
          tx,
          planRow.id,
          lineTotals,
        );

        return {
          planId: planRow.id,
          categories: decorateWithCheckState(aggregated, checkStates),
        };
      });
    }),

  toggleChecked: protectedProcedure
    .input(toggleShoppingItemCheckedInputSchema)
    .output(toggleShoppingItemCheckedResultSchema)
    .mutation(
      async ({ ctx, input }): Promise<ToggleShoppingItemCheckedResult> => {
        const withTransaction = makeWithTransaction(ctx.db);
        return await withTransaction(async (tx) => {
          const planRow = await loadHouseholdPlan(tx, input.planId);

          // Re-run the contribution SQL scoped to one ingredient so the
          // total we stamp is the server's authoritative current total
          // (DEC-31). A client-supplied quantity would let stale snapshots
          // poison the reset invariant. Zero rows here means the ingredient
          // no longer participates in the plan — refuse rather than plant
          // an orphan `shopping_list_items` row.
          const contributions = await selectIngredientContributions(
            tx,
            planRow.id,
            input.ingredientId,
          );
          if (contributions.length === 0) {
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: 'Ingredient does not contribute to this plan',
              cause: { code: 'SHOPPING_INGREDIENT_NOT_IN_PLAN' },
            });
          }

          const lastCheckedQuantity = input.isChecked
            ? computeIngredientTotal(contributions, planRow.startDate)
            : null;

          await tx
            .insert(shoppingListItems)
            .values({
              planId: planRow.id,
              ingredientId: input.ingredientId,
              isChecked: input.isChecked,
              lastCheckedQuantity,
            })
            .onConflictDoUpdate({
              target: [
                shoppingListItems.planId,
                shoppingListItems.ingredientId,
              ],
              set: {
                isChecked: input.isChecked,
                lastCheckedQuantity,
              },
            });

          return {
            planId: planRow.id,
            ingredientId: input.ingredientId,
            isChecked: input.isChecked,
          };
        });
      },
    ),
});

interface PlanRow {
  id: number;
  startDate: Date;
}

async function loadHouseholdPlan(tx: Tx, id: number): Promise<PlanRow> {
  const rows = await tx
    .select({ id: mealPlans.id, startDate: mealPlans.startDate })
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
  tx: Tx,
  planId: number,
): Promise<ShoppingContribution[]> {
  const rows = await tx
    .select(contributionProjection)
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
  tx: Tx,
  planId: number,
): Promise<ShoppingContribution[]> {
  const rows = await tx
    .select(cooksBaseContributionProjection)
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

// Both meal and cooks-base contribution paths scoped to one ingredient.
// Used by `toggleChecked` to (a) prove the ingredient contributes at all and
// (b) compute the authoritative current total to stamp into the row.
async function selectIngredientContributions(
  tx: Tx,
  planId: number,
  ingredientId: number,
): Promise<ShoppingContribution[]> {
  const [meal, base] = await Promise.all([
    tx
      .select(contributionProjection)
      .from(mealPlanSlots)
      .innerJoin(mealPlans, eq(mealPlans.id, mealPlanSlots.planId))
      .innerJoin(recipes, eq(recipes.id, mealPlanSlots.recipeId))
      .innerJoin(recipeIngredients, eq(recipeIngredients.recipeId, recipes.id))
      .innerJoin(
        ingredients,
        eq(ingredients.id, recipeIngredients.ingredientId),
      )
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
          eq(ingredients.id, ingredientId),
        ),
      ),
    tx
      .select(cooksBaseContributionProjection)
      .from(mealPlanSlots)
      .innerJoin(mealPlans, eq(mealPlans.id, mealPlanSlots.planId))
      .innerJoin(recipes, eq(recipes.id, mealPlanSlots.cooksBaseRecipeId))
      .innerJoin(recipeIngredients, eq(recipeIngredients.recipeId, recipes.id))
      .innerJoin(
        ingredients,
        eq(ingredients.id, recipeIngredients.ingredientId),
      )
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
          eq(ingredients.id, ingredientId),
        ),
      ),
  ]);

  return [...meal.map(toContribution), ...base.map(toContribution)];
}

const contributionProjection = {
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
  averageShelfLifeDays: ingredients.averageShelfLifeDays,
  // numeric arithmetic preserves precision; round to the column's
  // numeric(10,3) scale so the helper's integer-milli math is exact.
  scaledQuantity: sql<string>`round(${recipeIngredients.quantity} * ${mealPlanSlots.numberOfServings}::numeric / ${recipes.baseServings}::numeric, 3)`,
} as const;

const cooksBaseContributionProjection = {
  ...contributionProjection,
  scaledQuantity: sql<string>`round(${recipeIngredients.quantity} * ${mealPlanSlots.cooksBaseServings}::numeric / ${recipes.baseServings}::numeric, 3)`,
} as const;

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
  averageShelfLifeDays: number | null;
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
    averageShelfLifeDays: row.averageShelfLifeDays,
    scaledQuantity: row.scaledQuantity,
  };
}

function collectIngredientTotals(
  categories: AggregatedShoppingListCategory[],
): Map<number, string> {
  const totals = new Map<number, string>();
  for (const cat of categories) {
    for (const line of cat.lines) {
      totals.set(line.ingredient.id, line.totalQuantity);
    }
  }
  return totals;
}

// Single ingredient's contribution sum, expressed as a numeric(10,3) string
// for storage in `last_checked_quantity`. The aggregation helper already
// performs the milli arithmetic — reusing it here keeps the parsing /
// formatting rules in one place.
function computeIngredientTotal(
  contributions: ShoppingContribution[],
  planStart: Date,
): string {
  const aggregated = aggregateContributions(contributions, { planStart });
  const total = aggregated[0]?.lines[0]?.totalQuantity;
  if (!total) {
    throw new Error(
      'shopping.toggleChecked: aggregation produced no line for a non-empty contribution set',
    );
  }
  return total;
}

// Lazy-create + quantity-bound reset (DEC-30, DEC-31). Returns a map of
// every aggregated ingredient → its post-write `is_checked` value.
//
// Strategy (bulk SELECT-then-upsert):
//   1. Read every existing row for the plan in one query.
//   2. In memory, partition into: missing rows → insert (false / NULL);
//      checked-with-stale-total → reset (false / NULL); unchanged → no-op.
//   3. Bulk-insert the missing set with `ON CONFLICT DO NOTHING` (concurrent
//      first-reads).
//   4. Bulk-update the reset set with one statement scoped by ingredient_id.
//
// Numeric equality is exact via integer-milli (`'1.5'` vs `'1.500'` compare
// equal); naive string compare would over-fire the reset.
async function reconcileCheckState(
  tx: Tx,
  planId: number,
  ingredientTotals: Map<number, string>,
): Promise<Map<number, boolean>> {
  const existing = await tx
    .select({
      ingredientId: shoppingListItems.ingredientId,
      isChecked: shoppingListItems.isChecked,
      lastCheckedQuantity: shoppingListItems.lastCheckedQuantity,
    })
    .from(shoppingListItems)
    .where(eq(shoppingListItems.planId, planId));

  const existingByIngredient = new Map(
    existing.map((row) => [row.ingredientId, row]),
  );

  const toInsert: { ingredientId: number }[] = [];
  const toReset: number[] = [];
  const postWrite = new Map<number, boolean>();

  for (const [ingredientId, currentTotal] of ingredientTotals) {
    const row = existingByIngredient.get(ingredientId);
    if (!row) {
      toInsert.push({ ingredientId });
      postWrite.set(ingredientId, false);
      continue;
    }
    if (row.isChecked) {
      const stale =
        row.lastCheckedQuantity === null ||
        parseMilliFromFixed3(row.lastCheckedQuantity) !==
          parseMilliFromFixed3(currentTotal);
      if (stale) {
        toReset.push(ingredientId);
        postWrite.set(ingredientId, false);
        continue;
      }
    }
    postWrite.set(ingredientId, row.isChecked);
  }

  if (toInsert.length > 0) {
    await tx
      .insert(shoppingListItems)
      .values(
        toInsert.map((entry) => ({
          planId,
          ingredientId: entry.ingredientId,
          isChecked: false,
          lastCheckedQuantity: null,
        })),
      )
      .onConflictDoNothing({
        target: [shoppingListItems.planId, shoppingListItems.ingredientId],
      });
  }

  if (toReset.length > 0) {
    await tx
      .update(shoppingListItems)
      .set({ isChecked: false, lastCheckedQuantity: null })
      .where(
        and(
          eq(shoppingListItems.planId, planId),
          inArray(shoppingListItems.ingredientId, toReset),
        ),
      );
  }

  return postWrite;
}

function decorateWithCheckState(
  categories: AggregatedShoppingListCategory[],
  checkStates: Map<number, boolean>,
): ShoppingListCategory[] {
  return categories.map((cat) => ({
    category: cat.category,
    lines: cat.lines.map((line) => ({
      ...line,
      isChecked: checkStates.get(line.ingredient.id) ?? false,
    })),
  }));
}
