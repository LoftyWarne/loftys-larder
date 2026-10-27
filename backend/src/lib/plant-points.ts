import { type AnyColumn, type SQL, sql } from 'drizzle-orm';

import type { Db } from '../db/index.ts';
import { ingredients } from '../db/schema/ingredients.ts';
import { recipeIngredients, recipes } from '../db/schema/recipes.ts';
import type { Tx } from '../db/withTransaction.ts';

import {
  proposedEatenItems,
  savedEatenItems,
  type EatenDish,
} from './eaten-items.ts';

// Recipe-level plant points: COUNT(DISTINCT ingredient_id) over the recipe's
// non-optional ingredients filtered to `is_plant = true` (DEC-32 — never
// stored). Optional lines are excluded everywhere — you might not add them. DISTINCT
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
      and recipe_ingredients.is_optional = false
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
      and recipe_ingredients.is_optional = false
      and ingredients.is_plant = true
  `);
  const row = rows.rows[0];
  return row ? row.count : 0;
}

// Day / plan plant points count what's *eaten* (DEC-91), composing the
// recipe-level primitive over two contribution sources per eaten dish,
// unioned then DISTINCT-counted at the ingredient_id level:
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
// The eaten dishes come from a saved plan or from a proposal in Plan Review
// (`eaten-items.ts`); both are household-scoped, which keeps the helpers safe
// even if a caller forgets the procedure-layer guard (DEC-17 / cross-cutting #3).

type DbHandle = Db | Tx;

interface DayPlantPointsArgs {
  planId: number;
  householdId: string;
  date: string;
}

export async function selectDayPlantPoints(
  db: DbHandle,
  { planId, householdId, date }: DayPlantPointsArgs,
): Promise<number> {
  return await countDistinctPlants(
    db,
    savedEatenItems(planId, householdId, date),
  );
}

interface PlanPlantPointsArgs {
  planId: number;
  householdId: string;
}

export async function selectPlanPlantPoints(
  db: DbHandle,
  { planId, householdId }: PlanPlantPointsArgs,
): Promise<number> {
  return await countDistinctPlants(
    db,
    savedEatenItems(planId, householdId, null),
  );
}

interface ProposedPlantPointsArgs {
  householdId: string;
  dishes: readonly EatenDish[];
  date: string | null;
}

export async function selectProposedPlantPoints(
  db: DbHandle,
  { householdId, dishes, date }: ProposedPlantPointsArgs,
): Promise<number> {
  if (dishes.length === 0) return 0;
  return await countDistinctPlants(
    db,
    proposedEatenItems(dishes, householdId, date),
  );
}

async function countDistinctPlants(
  db: DbHandle,
  eatenItems: SQL,
): Promise<number> {
  // Bare column references inside `sql` templates drop the table qualifier;
  // both `recipe_ingredients` and `ingredients` carry an `id` column, so
  // every join predicate and projection in the inner unions is fully
  // qualified by name to dodge "column reference ambiguous". The outer
  // SELECT projects only `ingredient_id` — single source, no shadowing.
  const rows = await db.execute<{ count: number }>(sql`
    with eaten_items as (${eatenItems})
    select count(distinct contributions.ingredient_id)::int as count
    from (
      -- 1. eaten-item ingredients
      select recipe_ingredients.ingredient_id
      from eaten_items
      inner join ${recipeIngredients}
        on recipe_ingredients.recipe_id = eaten_items.recipe_id
        and recipe_ingredients.is_optional = false

      union all
      -- 2. serving-variation traversal: an eaten item's base
      select recipe_ingredients.ingredient_id
      from eaten_items
      inner join ${recipes}
        on recipes.id = eaten_items.recipe_id
      inner join ${recipeIngredients}
        on recipe_ingredients.recipe_id = recipes.base_recipe_id
        and recipe_ingredients.is_optional = false
      where recipes.base_recipe_id is not null
    ) as contributions
    inner join ${ingredients}
      on ingredients.id = contributions.ingredient_id
    where ingredients.is_plant = true
  `);

  const row = rows.rows[0];
  return row ? row.count : 0;
}
