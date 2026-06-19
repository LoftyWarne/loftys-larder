import { type AnyColumn, type SQL, sql } from 'drizzle-orm';

import type { Db } from '../db/index.ts';
import { ingredients } from '../db/schema/ingredients.ts';
import { recipeIngredients } from '../db/schema/recipes.ts';

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
