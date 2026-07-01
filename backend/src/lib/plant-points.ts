import { type AnyColumn, type SQL, sql } from 'drizzle-orm';

import type { Db } from '../db/index.ts';
import { ingredients } from '../db/schema/ingredients.ts';
import {
  mealPlans,
  mealPlanSlotItems,
  mealPlanSlots,
} from '../db/schema/meal-plans.ts';
import { recipeIngredients, recipes } from '../db/schema/recipes.ts';
import type { Tx } from '../db/withTransaction.ts';

// Recipe-level plant points: COUNT(DISTINCT ingredient_id) over the recipe's
// ingredients filtered to `is_plant = true` (DEC-32 — never stored). DISTINCT
// covers the "same plant entered twice with different prep types" case (e.g.
// 1 onion sliced + 1 onion diced count as one point).
//
// FEAT-41 reuses this primitive at day/plan level, composing with the
// batch-traversal logic there — keep this helper pure and small so the
// downstream composition stays straightforward.

// Inside a `sql` template the column references are rendered bare (no table
// qualifier), so the subquery joins must spell out `<table>.<column>` to avoid
// "column reference ambiguous" between `recipe_ingredients.id` and
// `ingredients.id`. Drizzle does fully qualify column-object references at
// the top level — it's the in-template renderer that drops the prefix. The
// `outerRecipeIdSql` parameter is also required to be fully qualified (e.g.
// `sql\`recipes.id\``) so the correlated reference doesn't collide either.

/**
 * Correlated scalar subquery returning the plant-points count for a recipe
 * id expression. Use inside a `SELECT` list when joining many recipes; the
 * GIN index isn't hit but the table is small per-recipe so the correlated
 * subquery is cheaper than a separate aggregation pass at this scale.
 *
 * Pass either a literal recipe id (for one-off lookups) or an already-
 * qualified SQL fragment (e.g. `sql\`recipes.id\``) so the correlated
 * reference is unambiguous against the subquery's own join.
 */
export function recipePlantPointsExpr(
  outerRecipeIdSql: SQL | AnyColumn | number,
): SQL<number> {
  return sql<number>`(
    select count(distinct recipe_ingredients.ingredient_id)::int
    from ${recipeIngredients}
    inner join ${ingredients}
      on ingredients.id = recipe_ingredients.ingredient_id
    where recipe_ingredients.recipe_id = ${outerRecipeIdSql}
      and ingredients.is_plant = true
  )`;
}

/**
 * Standalone evaluator. Convenient for tests and one-off reads. The list
 * procedure inlines the expression above to keep the round-trip count down.
 */
export async function selectRecipePlantPoints(
  db: Db,
  recipeId: number,
): Promise<number> {
  const rows = await db.execute<{ count: number }>(sql`
    select count(distinct recipe_ingredients.ingredient_id)::int as count
    from ${recipeIngredients}
    inner join ${ingredients}
      on ingredients.id = recipe_ingredients.ingredient_id
    where recipe_ingredients.recipe_id = ${recipeId}
      and ingredients.is_plant = true
  `);
  const row = rows.rows[0];
  return row ? row.count : 0;
}

// Day / plan plant points count what's *eaten* (DEC-91), composing the
// recipe-level primitive over two contribution sources per slot, unioned then
// DISTINCT-counted at the ingredient_id level:
//
//   1. eaten recipe                        — items with eaten > 0
//   2. base traversal: an eaten variation  — its base, when base_recipe_id IS NOT NULL
//
// A dish is only counted once it's eaten (eaten > 0). A batch cooked purely for
// later contributes nothing on the cooking day; its plants land on the day/slot
// it is actually eaten (a later meal or leftovers slot). COUNT(DISTINCT
// ingredient_id) gives the spec's dedup for free, including the "eaten meal's
// base = a base cooked the same day" case (DEC-32, FEAT-41).
//
// The household-scoped plan join keeps the helpers safe even if a caller
// forgets the procedure-layer guard (DEC-17 / cross-cutting #3).

type DbHandle = Db | Tx;

interface DayPlantPointsArgs {
  planId: number;
  householdId: string;
  date: string;
}

interface PlanPlantPointsArgs {
  planId: number;
  householdId: string;
}

export async function selectDayPlantPoints(
  db: DbHandle,
  { planId, householdId, date }: DayPlantPointsArgs,
): Promise<number> {
  return await countDistinctPlants(db, {
    planId,
    householdId,
    dateFilter: sql`and meal_plan_slots.date = ${date}::date`,
  });
}

export async function selectPlanPlantPoints(
  db: DbHandle,
  { planId, householdId }: PlanPlantPointsArgs,
): Promise<number> {
  return await countDistinctPlants(db, {
    planId,
    householdId,
    dateFilter: sql``,
  });
}

interface CountArgs {
  planId: number;
  householdId: string;
  dateFilter: SQL;
}

async function countDistinctPlants(
  db: DbHandle,
  { planId, householdId, dateFilter }: CountArgs,
): Promise<number> {
  // Bare column references inside `sql` templates drop the table qualifier;
  // both `recipe_ingredients` and `ingredients` carry an `id` column, so
  // every join predicate and projection in the inner unions is fully
  // qualified by name to dodge "column reference ambiguous". The outer
  // SELECT projects only `ingredient_id` — single source, no shadowing.
  const planFilter = sql`meal_plans.id = ${planId} and meal_plans.household_id = ${householdId}`;

  const rows = await db.execute<{ count: number }>(sql`
    select count(distinct contributions.ingredient_id)::int as count
    from (
      -- 1. eaten-item ingredients
      select recipe_ingredients.ingredient_id
      from ${mealPlanSlots}
      inner join ${mealPlans}
        on meal_plans.id = meal_plan_slots.plan_id
      inner join ${mealPlanSlotItems}
        on meal_plan_slot_items.slot_id = meal_plan_slots.id
        and meal_plan_slot_items.eaten > 0
      inner join ${recipeIngredients}
        on recipe_ingredients.recipe_id = meal_plan_slot_items.recipe_id
      where ${planFilter}
        ${dateFilter}

      union all
      -- 2. serving-variation traversal: an eaten item's base
      select recipe_ingredients.ingredient_id
      from ${mealPlanSlots}
      inner join ${mealPlans}
        on meal_plans.id = meal_plan_slots.plan_id
      inner join ${mealPlanSlotItems}
        on meal_plan_slot_items.slot_id = meal_plan_slots.id
        and meal_plan_slot_items.eaten > 0
      inner join ${recipes}
        on recipes.id = meal_plan_slot_items.recipe_id
      inner join ${recipeIngredients}
        on recipe_ingredients.recipe_id = recipes.base_recipe_id
      where ${planFilter}
        and recipes.base_recipe_id is not null
        ${dateFilter}
    ) as contributions
    inner join ${ingredients}
      on ingredients.id = contributions.ingredient_id
    where ingredients.is_plant = true
  `);

  const row = rows.rows[0];
  return row ? row.count : 0;
}
