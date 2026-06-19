import { and, asc, eq, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import { OCCASION_ORDER } from '../../../shared/src/lib/occasion-order.ts';
import * as schema from '../db/schema/index.ts';
import { mealPlanSlots } from '../db/schema/meal-plans.ts';
import { mealOccasions } from '../db/schema/reference.ts';
import type { Tx } from '../db/withTransaction.ts';

type Schema = typeof schema;
type DbHandle = NodePgDatabase<Schema> | Tx;

// Reusable predicate: "does this plan have a slot cooking `baseRecipeId` that
// is at-or-before the slot identified by `slotId`?" Used by the planner UI's
// soft warning (FEAT-32), and consumed by aggregation (FEAT-36) and
// plant-points (FEAT-41) for the same earlier-or-same-occasion semantics.
//
// "Earlier-or-same" means: an earlier calendar date, or the same date with an
// equal-or-earlier occasion ordinal (OCCASION_ORDER, e.g. Lunch < Dinner), or
// the same slot id (self-supply: a slot that both eats a batch-version and
// cooks the base counts as supplying itself).
export interface HasBaseSupplyInput {
  planId: number;
  slotId: number;
  baseRecipeId: number;
}

export interface HasBaseSupplyResult {
  hasSupply: boolean;
  earliestSupplySlotId?: number;
}

export async function hasBaseSupply(
  db: DbHandle,
  { planId, slotId, baseRecipeId }: HasBaseSupplyInput,
): Promise<HasBaseSupplyResult> {
  // The target slot anchors the comparison; without its (date, occasion) we
  // can't decide what "earlier-or-same" means.
  const targetRows = await db
    .select({
      date: mealPlanSlots.date,
      occasionName: mealOccasions.name,
    })
    .from(mealPlanSlots)
    .innerJoin(mealOccasions, eq(mealPlanSlots.occasionId, mealOccasions.id))
    .where(and(eq(mealPlanSlots.id, slotId), eq(mealPlanSlots.planId, planId)))
    .limit(1);
  const target = targetRows[0];
  if (!target) {
    return { hasSupply: false };
  }
  const targetOccasionOrder = OCCASION_ORDER[target.occasionName] ?? 0;

  // SQL CASE mirrors the JS OCCASION_ORDER map. If the seed list grows beyond
  // Lunch/Dinner, both sides need the addition — kept in lockstep by the
  // shared module they both consume at boot.
  const occasionOrderCase = sql<number>`CASE ${mealOccasions.name}
    WHEN 'Lunch' THEN 0
    WHEN 'Dinner' THEN 1
    ELSE 999
  END`;

  const candidates = await db
    .select({
      id: mealPlanSlots.id,
      date: mealPlanSlots.date,
      occasionOrder: occasionOrderCase,
    })
    .from(mealPlanSlots)
    .innerJoin(mealOccasions, eq(mealPlanSlots.occasionId, mealOccasions.id))
    .where(
      and(
        eq(mealPlanSlots.planId, planId),
        eq(mealPlanSlots.cooksBaseRecipeId, baseRecipeId),
        or(
          sql`${mealPlanSlots.date} < ${target.date}`,
          and(
            sql`${mealPlanSlots.date} = ${target.date}`,
            sql`${occasionOrderCase} <= ${targetOccasionOrder}`,
          ),
        ),
      ),
    )
    .orderBy(
      asc(mealPlanSlots.date),
      asc(occasionOrderCase),
      asc(mealPlanSlots.id),
    )
    .limit(1);

  const earliest = candidates[0];
  if (!earliest) {
    return { hasSupply: false };
  }
  return { hasSupply: true, earliestSupplySlotId: earliest.id };
}
