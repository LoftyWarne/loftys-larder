import { TRPCError } from '@trpc/server';
import { and, asc, desc, eq, gte, lt, sql } from 'drizzle-orm';

import {
  createPlanInputSchema,
  createPlanResultSchema,
  deletePlanInputSchema,
  deletePlanResultSchema,
  getPlanInputSchema,
  getPlanResultSchema,
  listPlansInputSchema,
  listPlansResultSchema,
  PLAN_MAX_RANGE_DAYS,
  planSchema,
  type CreatePlanResult,
  type DeletePlanResult,
  type GetPlanResult,
  type ListPlansResult,
  type Plan,
  type PlanSlot,
} from '../../../../shared/src/index.ts';
import { CURRENT_HOUSEHOLD_ID } from '../../config.ts';
import { mealPlans, mealPlanSlots } from '../../db/schema/meal-plans.ts';
import { recipes } from '../../db/schema/recipes.ts';
import { mealOccasions } from '../../db/schema/reference.ts';
import { makeWithTransaction } from '../../db/withTransaction.ts';
import {
  daysBetween,
  formatCivilDate,
  parseCivilDate,
  todayInLondon,
} from '../../lib/date-utils.ts';
import { generateEmptySlotsForRange } from '../../lib/slot-generation.ts';
import { protectedProcedure, router } from '../init.ts';

export const plansRouter = router({
  create: protectedProcedure
    .input(createPlanInputSchema)
    .output(createPlanResultSchema)
    .mutation(async ({ ctx, input }): Promise<CreatePlanResult> => {
      const startDate = parseCivilDate(input.startDate);
      const endDate = parseCivilDate(input.endDate);

      if (daysBetween(startDate, endDate) > PLAN_MAX_RANGE_DAYS) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Plan range cannot exceed ${PLAN_MAX_RANGE_DAYS.toString()} days`,
          cause: {
            code: 'PLAN_RANGE_TOO_LONG',
            maxDays: PLAN_MAX_RANGE_DAYS,
          },
        });
      }

      const today = todayInLondon();

      // Overlap check (DEC-38): any non-past plan in this household whose
      // [start_date, end_date] intersects the proposed range. Inclusive
      // boundary semantics — a plan ending on D blocks a new plan starting
      // on D, matching the spec's `NOT (other.end < new.start OR other.start
      // > new.end)` formulation. `end_date >= today` exempts past plans.
      const conflicting = await ctx.db
        .select({ id: mealPlans.id })
        .from(mealPlans)
        .where(
          and(
            eq(mealPlans.householdId, CURRENT_HOUSEHOLD_ID),
            gte(mealPlans.endDate, today),
            sql`NOT (${mealPlans.endDate} < ${startDate} OR ${mealPlans.startDate} > ${endDate})`,
          ),
        );

      if (conflicting.length > 0) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Plan overlaps with an existing active or future plan',
          cause: {
            code: 'PLAN_DATE_OVERLAP',
            conflictingPlanIds: conflicting.map((row) => row.id),
          },
        });
      }

      const occasionRows = await ctx.db
        .select({ id: mealOccasions.id })
        .from(mealOccasions)
        .orderBy(asc(mealOccasions.id));
      if (occasionRows.length === 0) {
        // Reference data ships in the seed (`MEAL_OCCASIONS`); an empty
        // table means deployment misconfiguration, not user error.
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'No meal occasions configured',
        });
      }
      const occasionIds = occasionRows.map((row) => row.id);

      const withTransaction = makeWithTransaction(ctx.db);
      const { plan, slotCount } = await withTransaction(async (tx) => {
        const inserted = await tx
          .insert(mealPlans)
          .values({
            householdId: CURRENT_HOUSEHOLD_ID,
            createdByUserId: ctx.user.id,
            startDate,
            endDate,
            name: input.name,
          })
          .returning({
            id: mealPlans.id,
            name: mealPlans.name,
            startDate: mealPlans.startDate,
            endDate: mealPlans.endDate,
            createdByUserId: mealPlans.createdByUserId,
          });
        const row = inserted[0];
        if (!row) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Plan insert returned no row',
          });
        }
        const count = await generateEmptySlotsForRange(
          tx,
          row.id,
          startDate,
          endDate,
          occasionIds,
        );
        return { plan: toPlanDto(row), slotCount: count };
      });

      return { plan, slotCount };
    }),

  list: protectedProcedure
    .input(listPlansInputSchema)
    .output(listPlansResultSchema)
    .query(async ({ ctx, input }): Promise<ListPlansResult> => {
      const today = todayInLondon();
      const conditions = [eq(mealPlans.householdId, CURRENT_HOUSEHOLD_ID)];

      if (input.status === 'active') {
        // today BETWEEN start_date AND end_date — inclusive both sides.
        conditions.push(
          sql`${mealPlans.startDate} <= ${today} AND ${mealPlans.endDate} >= ${today}`,
        );
      } else if (input.status === 'past') {
        conditions.push(lt(mealPlans.endDate, today));
      } else if (input.status === 'future') {
        conditions.push(sql`${mealPlans.startDate} > ${today}`);
      }
      // status === 'all' adds no extra predicate.

      const rows = await ctx.db
        .select({
          id: mealPlans.id,
          name: mealPlans.name,
          startDate: mealPlans.startDate,
          endDate: mealPlans.endDate,
          createdByUserId: mealPlans.createdByUserId,
        })
        .from(mealPlans)
        .where(and(...conditions))
        .orderBy(desc(mealPlans.startDate), desc(mealPlans.id));

      return { items: rows.map(toPlanDto) };
    }),

  get: protectedProcedure
    .input(getPlanInputSchema)
    .output(getPlanResultSchema)
    .query(async ({ ctx, input }): Promise<GetPlanResult> => {
      const planRows = await ctx.db
        .select({
          id: mealPlans.id,
          name: mealPlans.name,
          startDate: mealPlans.startDate,
          endDate: mealPlans.endDate,
          createdByUserId: mealPlans.createdByUserId,
        })
        .from(mealPlans)
        .where(
          and(
            eq(mealPlans.id, input.id),
            eq(mealPlans.householdId, CURRENT_HOUSEHOLD_ID),
          ),
        )
        .limit(1);
      const planRow = planRows[0];
      if (!planRow) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Plan not found',
        });
      }

      // LEFT JOIN recipes without an `is_deleted` filter so historical slots
      // referencing soft-deleted recipes still render (DEC-21). meal_occasions
      // join provides the occasion name for the UI to label columns.
      const slotRows = await ctx.db
        .select({
          id: mealPlanSlots.id,
          planId: mealPlanSlots.planId,
          date: mealPlanSlots.date,
          occasionId: mealPlanSlots.occasionId,
          occasionName: mealOccasions.name,
          slotType: mealPlanSlots.slotType,
          recipeId: mealPlanSlots.recipeId,
          numberOfServings: mealPlanSlots.numberOfServings,
          chefUserId: mealPlanSlots.chefUserId,
          cooksBaseRecipeId: mealPlanSlots.cooksBaseRecipeId,
          cooksBaseServings: mealPlanSlots.cooksBaseServings,
          recipeName: recipes.name,
          recipeImageUrl: recipes.imageUrl,
          recipeIsBase: recipes.isBase,
          recipeIsDeleted: recipes.isDeleted,
        })
        .from(mealPlanSlots)
        .innerJoin(
          mealOccasions,
          eq(mealPlanSlots.occasionId, mealOccasions.id),
        )
        .leftJoin(recipes, eq(mealPlanSlots.recipeId, recipes.id))
        .where(eq(mealPlanSlots.planId, planRow.id))
        .orderBy(asc(mealPlanSlots.date), asc(mealPlanSlots.occasionId));

      const slots: PlanSlot[] = slotRows.map((row) => ({
        id: row.id,
        planId: row.planId,
        date: formatCivilDate(row.date),
        occasionId: row.occasionId,
        occasionName: row.occasionName,
        slotType: row.slotType,
        recipeId: row.recipeId,
        numberOfServings: row.numberOfServings,
        chefUserId: row.chefUserId,
        cooksBaseRecipeId: row.cooksBaseRecipeId,
        cooksBaseServings: row.cooksBaseServings,
        recipe:
          row.recipeId === null || row.recipeName === null
            ? null
            : {
                id: row.recipeId,
                name: row.recipeName,
                imageUrl: row.recipeImageUrl,
                isBase: row.recipeIsBase ?? false,
                isDeleted: row.recipeIsDeleted ?? false,
              },
      }));

      return { ...toPlanDto(planRow), slots };
    }),

  delete: protectedProcedure
    .input(deletePlanInputSchema)
    .output(deletePlanResultSchema)
    .mutation(async ({ ctx, input }): Promise<DeletePlanResult> => {
      // Hard delete; FK cascade on `meal_plan_slots.plan_id` and
      // `shopping_list_items.plan_id` removes the dependent rows.
      // Household-scoped DELETE in one statement — the row either belongs to
      // this household or `rowCount` stays at zero, in which case we surface
      // NOT_FOUND (matching the cross-household isolation pattern).
      const deleted = await ctx.db
        .delete(mealPlans)
        .where(
          and(
            eq(mealPlans.id, input.id),
            eq(mealPlans.householdId, CURRENT_HOUSEHOLD_ID),
          ),
        )
        .returning({ id: mealPlans.id });

      const row = deleted[0];
      if (!row) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Plan not found',
        });
      }
      return { id: row.id };
    }),
});

interface PlanRow {
  id: number;
  name: string;
  startDate: Date;
  endDate: Date;
  createdByUserId: string | null;
}

function toPlanDto(row: PlanRow): Plan {
  return planSchema.parse({
    id: row.id,
    name: row.name,
    startDate: formatCivilDate(row.startDate),
    endDate: formatCivilDate(row.endDate),
    createdByUserId: row.createdByUserId,
  });
}
