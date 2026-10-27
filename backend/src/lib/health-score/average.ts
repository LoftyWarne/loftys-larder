import { type SQL, sql } from 'drizzle-orm';

import type { HealthScoreAverage } from '../../../../shared/src/index.ts';
import type { Db } from '../../db/index.ts';
import { recipeHealthScores } from '../../db/schema/recipe-health.ts';
import type { Tx } from '../../db/withTransaction.ts';
import {
  proposedEatenItems,
  savedEatenItems,
  type EatenDish,
} from '../eaten-items.ts';

// Day / plan Health Score (DEC-113): `sum(score * eaten) / sum(eaten)` over
// eaten items whose recipe has a score, out of date or not. Computed on read,
// never stored (DEC-32). A serving variation uses its own score, which
// already covers its base, so there's no base traversal. Only items with
// `eaten > 0` take part: a plan-meal leftover is one, and eat out, takeaway,
// other leftovers and empty slots have none, so no slot-type check is needed.
// A soft-deleted recipe still counts, so past plans read as they did.
//
// The eaten dishes come from a saved plan or from a proposal in Plan Review
// (`eaten-items.ts`); both are household-scoped (DEC-17).

type DbHandle = Db | Tx;

interface DayArgs {
  planId: number;
  householdId: string;
  date: string;
}

interface PlanArgs {
  planId: number;
  householdId: string;
}

export async function selectDayHealthScore(
  db: DbHandle,
  { planId, householdId, date }: DayArgs,
): Promise<HealthScoreAverage> {
  return await averageHealthScore(
    db,
    savedEatenItems(planId, householdId, date),
  );
}

export async function selectPlanHealthScore(
  db: DbHandle,
  { planId, householdId }: PlanArgs,
): Promise<HealthScoreAverage> {
  return await averageHealthScore(
    db,
    savedEatenItems(planId, householdId, null),
  );
}

interface ProposedArgs {
  householdId: string;
  dishes: readonly EatenDish[];
  date: string | null;
}

export async function selectProposedHealthScore(
  db: DbHandle,
  { householdId, dishes, date }: ProposedArgs,
): Promise<HealthScoreAverage> {
  if (dishes.length === 0) {
    return { average: null, notScored: 0, includesOutOfDate: false };
  }
  return await averageHealthScore(
    db,
    proposedEatenItems(dishes, householdId, date),
  );
}

// The one place the average is rounded, to one decimal place.
export function roundAverage(weightedSum: number, weight: number): number {
  return Math.round((weightedSum * 10) / weight) / 10;
}

async function averageHealthScore(
  db: DbHandle,
  eatenItems: SQL,
): Promise<HealthScoreAverage> {
  const rows = await db.execute<{
    weighted_sum: number;
    weight: number;
    not_scored: number;
    includes_out_of_date: boolean;
  }>(sql`
    with eaten_items as (${eatenItems})
    select
      coalesce(sum(recipe_health_scores.score * eaten_items.eaten), 0)::int
        as weighted_sum,
      coalesce(sum(eaten_items.eaten)
        filter (where recipe_health_scores.recipe_id is not null), 0)::int
        as weight,
      count(distinct eaten_items.recipe_id)
        filter (where recipe_health_scores.recipe_id is null)::int
        as not_scored,
      coalesce(bool_or(recipe_health_scores.is_stale), false)
        as includes_out_of_date
    from eaten_items
    left join ${recipeHealthScores}
      on recipe_health_scores.recipe_id = eaten_items.recipe_id
  `);

  const row = rows.rows[0];
  if (!row || row.weight === 0) {
    return {
      average: null,
      notScored: row?.not_scored ?? 0,
      includesOutOfDate: false,
    };
  }
  return {
    average: roundAverage(row.weighted_sum, row.weight),
    notScored: row.not_scored,
    includesOutOfDate: row.includes_out_of_date,
  };
}
