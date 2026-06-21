import { TRPCError } from '@trpc/server';
import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import {
  getDayPlantPointsInputSchema,
  getDayPlantPointsResultSchema,
  getPlanPlantPointsInputSchema,
  getPlanPlantPointsResultSchema,
  type GetDayPlantPointsResult,
  type GetPlanPlantPointsResult,
} from '../../../../shared/src/index.ts';
import { CURRENT_HOUSEHOLD_ID } from '../../config.ts';
import * as schema from '../../db/schema/index.ts';
import { mealPlans } from '../../db/schema/meal-plans.ts';
import type { Tx } from '../../db/withTransaction.ts';
import {
  selectDayPlantPoints,
  selectPlanPlantPoints,
} from '../../lib/plant-points.ts';
import { protectedProcedure, router } from '../init.ts';

type Schema = typeof schema;
type DbHandle = NodePgDatabase<Schema> | Tx;

export const plantsRouter = router({
  forDay: protectedProcedure
    .input(getDayPlantPointsInputSchema)
    .output(getDayPlantPointsResultSchema)
    .query(async ({ ctx, input }): Promise<GetDayPlantPointsResult> => {
      await assertHouseholdPlan(ctx.db, input.planId);
      const count = await selectDayPlantPoints(ctx.db, {
        planId: input.planId,
        householdId: CURRENT_HOUSEHOLD_ID,
        date: input.date,
      });
      return { count };
    }),

  forPlan: protectedProcedure
    .input(getPlanPlantPointsInputSchema)
    .output(getPlanPlantPointsResultSchema)
    .query(async ({ ctx, input }): Promise<GetPlanPlantPointsResult> => {
      await assertHouseholdPlan(ctx.db, input.planId);
      const count = await selectPlanPlantPoints(ctx.db, {
        planId: input.planId,
        householdId: CURRENT_HOUSEHOLD_ID,
      });
      return { count };
    }),
});

// Cross-household isolation guard (DEC-17). The helper SQL also scopes by
// `household_id`, but failing fast at the procedure layer with NOT_FOUND
// matches the rest of the surface and avoids returning a count of 0 for a
// plan that doesn't belong to the caller.
async function assertHouseholdPlan(
  db: DbHandle,
  planId: number,
): Promise<void> {
  const rows = await db
    .select({ id: mealPlans.id })
    .from(mealPlans)
    .where(
      and(
        eq(mealPlans.id, planId),
        eq(mealPlans.householdId, CURRENT_HOUSEHOLD_ID),
      ),
    )
    .limit(1);
  if (rows.length === 0) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Plan not found',
    });
  }
}
