import { type SQL, sql } from 'drizzle-orm';

import type { HealthScoreAverage } from '../../../../shared/src/index.ts';
import type { Db } from '../../db/index.ts';
import {
  mealPlans,
  mealPlanSlotItems,
  mealPlanSlots,
} from '../../db/schema/meal-plans.ts';
import { recipeHealthScores } from '../../db/schema/recipe-health.ts';
import type { Tx } from '../../db/withTransaction.ts';

// Day / plan Health Score (DEC-113): `sum(score * eaten) / sum(eaten)` over
// eaten items whose recipe has a score, out of date or not. Computed on read,
// never stored (DEC-32). A serving variation uses its own score, which
// already covers its base, so there's no base traversal. Only items with
// `eaten > 0` take part: a plan-meal leftover is one, and eat out, takeaway,
// other leftovers and empty slots have none, so no slot-type check is needed.
// A soft-deleted recipe still counts, so past plans read as they did.
//
// The household-scoped plan join keeps the helpers safe even if a caller
// forgets the procedure-layer guard (DEC-17).

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
  return await averageHealthScore(db, {
    planId,
    householdId,
    dateFilter: sql`and meal_plan_slots.date = ${date}::date`,
  });
}

export async function selectPlanHealthScore(
  db: DbHandle,
  { planId, householdId }: PlanArgs,
): Promise<HealthScoreAverage> {
  return await averageHealthScore(db, {
    planId,
    householdId,
    dateFilter: sql``,
  });
}

// The one place the average is rounded, to one decimal place.
export function roundAverage(weightedSum: number, weight: number): number {
  return Math.round((weightedSum * 10) / weight) / 10;
}

interface AverageArgs {
  planId: number;
  householdId: string;
  dateFilter: SQL;
}

async function averageHealthScore(
  db: DbHandle,
  { planId, householdId, dateFilter }: AverageArgs,
): Promise<HealthScoreAverage> {
  const rows = await db.execute<{
    weighted_sum: number;
    weight: number;
    not_scored: number;
    includes_out_of_date: boolean;
  }>(sql`
    select
      coalesce(sum(recipe_health_scores.score * meal_plan_slot_items.eaten), 0)::int
        as weighted_sum,
      coalesce(sum(meal_plan_slot_items.eaten)
        filter (where recipe_health_scores.recipe_id is not null), 0)::int
        as weight,
      count(distinct meal_plan_slot_items.recipe_id)
        filter (where recipe_health_scores.recipe_id is null)::int
        as not_scored,
      coalesce(bool_or(recipe_health_scores.is_stale), false)
        as includes_out_of_date
    from ${mealPlanSlots}
    inner join ${mealPlans}
      on meal_plans.id = meal_plan_slots.plan_id
    inner join ${mealPlanSlotItems}
      on meal_plan_slot_items.slot_id = meal_plan_slots.id
      and meal_plan_slot_items.eaten > 0
    left join ${recipeHealthScores}
      on recipe_health_scores.recipe_id = meal_plan_slot_items.recipe_id
    where meal_plans.id = ${planId}
      and meal_plans.household_id = ${householdId}
      ${dateFilter}
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
