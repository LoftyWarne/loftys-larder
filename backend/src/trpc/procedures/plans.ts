import { TRPCError } from '@trpc/server';
import { and, asc, desc, eq, gte, inArray, lt, ne, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { alias } from 'drizzle-orm/pg-core';

import {
  createPlanInputSchema,
  createPlanResultSchema,
  deletePlanInputSchema,
  deletePlanResultSchema,
  duplicatePlanInputSchema,
  duplicatePlanResultSchema,
  getPlanInputSchema,
  getPlanResultSchema,
  listPlansInputSchema,
  listPlansResultSchema,
  PLAN_MAX_RANGE_DAYS,
  planSchema,
  updatePlanRangeInputSchema,
  updatePlanRangeResultSchema,
  type CreatePlanResult,
  type DeletePlanResult,
  type DuplicatePlanResult,
  type GetPlanResult,
  type ListPlansResult,
  type Plan,
  type PlanSlot,
  type PlanSlotLoss,
  type UpdatePlanRangeResult,
} from '../../../../shared/src/index.ts';
import { CURRENT_HOUSEHOLD_ID } from '../../config.ts';
import * as schema from '../../db/schema/index.ts';
import { mealPlans, mealPlanSlots } from '../../db/schema/meal-plans.ts';
import { recipes } from '../../db/schema/recipes.ts';
import { mealOccasions } from '../../db/schema/reference.ts';
import { makeWithTransaction, type Tx } from '../../db/withTransaction.ts';
import {
  addDays,
  daysBetween,
  eachDateInRange,
  formatCivilDate,
  parseCivilDate,
  todayInLondon,
} from '../../lib/date-utils.ts';
import {
  generateEmptySlotsForDates,
  generateEmptySlotsForRange,
} from '../../lib/slot-generation.ts';
import { protectedProcedure, router } from '../init.ts';

type Schema = typeof schema;
type DbHandle = NodePgDatabase<Schema> | Tx;

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

      const occasionIds = await loadOccasionIds(ctx.db);

      const withTransaction = makeWithTransaction(ctx.db);
      const { plan, slotCount } = await withTransaction(async (tx) => {
        const inserted = await tx
          .insert(mealPlans)
          .values({
            householdId: CURRENT_HOUSEHOLD_ID,
            createdByUserId: ctx.user.id,
            startDate,
            endDate,
          })
          .returning({
            id: mealPlans.id,
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
      const planRow = await loadHouseholdPlan(ctx.db, input.id);
      const slots = await selectPlanSlots(ctx.db, planRow.id);
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

  updateRange: protectedProcedure
    .input(updatePlanRangeInputSchema)
    .output(updatePlanRangeResultSchema)
    .mutation(async ({ ctx, input }): Promise<UpdatePlanRangeResult> => {
      const newStart = parseCivilDate(input.startDate);
      const newEnd = parseCivilDate(input.endDate);

      const planRow = await loadHouseholdPlan(ctx.db, input.id);
      const today = todayInLondon();

      // Past plans are immutable (DEC-83 follow-up; the planner UI only
      // surfaces edits on active/future plans). Re-planning the same dates
      // is supported via FEAT-29 duplication, not via mutating the original.
      if (planRow.endDate < today) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Past plans cannot be edited',
          cause: {
            code: 'PLAN_PAST_NOT_EDITABLE',
          },
        });
      }

      if (daysBetween(newStart, newEnd) > PLAN_MAX_RANGE_DAYS) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Plan range cannot exceed ${PLAN_MAX_RANGE_DAYS.toString()} days`,
          cause: {
            code: 'PLAN_RANGE_TOO_LONG',
            maxDays: PLAN_MAX_RANGE_DAYS,
          },
        });
      }

      // Overlap check (DEC-38) excluding self: shrinking or extending a
      // plan must never report it as conflicting with itself.
      const conflicting = await ctx.db
        .select({ id: mealPlans.id })
        .from(mealPlans)
        .where(
          and(
            eq(mealPlans.householdId, CURRENT_HOUSEHOLD_ID),
            ne(mealPlans.id, planRow.id),
            gte(mealPlans.endDate, today),
            sql`NOT (${mealPlans.endDate} < ${newStart} OR ${mealPlans.startDate} > ${newEnd})`,
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

      // Compute the symmetric date-set diff. Using formatted civil-date
      // strings as the set key avoids comparing `Date` objects by reference.
      const currentDates = new Set(
        eachDateInRange(planRow.startDate, planRow.endDate).map(
          formatCivilDate,
        ),
      );
      const newDates = new Set(
        eachDateInRange(newStart, newEnd).map(formatCivilDate),
      );
      const datesToAdd = [...newDates].filter((d) => !currentDates.has(d));
      const datesToRemove = [...currentDates].filter((d) => !newDates.has(d));

      // Pre-flight destructive-shrink check (spec implementation note: a
      // separate read at household scale is cheap). Without confirmation,
      // surface the list so the UI (FEAT-31) can render a confirm dialog.
      if (datesToRemove.length > 0 && !input.confirmDestructive) {
        const lostNonEmpty = await ctx.db
          .select({
            id: mealPlanSlots.id,
            date: mealPlanSlots.date,
            occasionId: mealPlanSlots.occasionId,
            slotType: mealPlanSlots.slotType,
            recipeId: mealPlanSlots.recipeId,
          })
          .from(mealPlanSlots)
          .where(
            and(
              eq(mealPlanSlots.planId, planRow.id),
              inArray(mealPlanSlots.date, datesToRemove.map(parseCivilDate)),
              ne(mealPlanSlots.slotType, 'empty'),
            ),
          )
          .orderBy(asc(mealPlanSlots.date), asc(mealPlanSlots.occasionId));

        if (lostNonEmpty.length > 0) {
          const slots: PlanSlotLoss[] = lostNonEmpty.map((row) => ({
            id: row.id,
            date: formatCivilDate(row.date),
            occasionId: row.occasionId,
            slotType: row.slotType,
            recipeId: row.recipeId,
          }));
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Shrink would discard assigned slots',
            cause: {
              code: 'PLAN_DESTRUCTIVE_RANGE_CHANGE',
              slots,
            },
          });
        }
      }

      const occasionIds = await loadOccasionIds(ctx.db);

      const withTransaction = makeWithTransaction(ctx.db);
      const { plan, slots } = await withTransaction(async (tx) => {
        const updated = await tx
          .update(mealPlans)
          .set({ startDate: newStart, endDate: newEnd })
          .where(
            and(
              eq(mealPlans.id, planRow.id),
              eq(mealPlans.householdId, CURRENT_HOUSEHOLD_ID),
            ),
          )
          .returning({
            id: mealPlans.id,
            startDate: mealPlans.startDate,
            endDate: mealPlans.endDate,
            createdByUserId: mealPlans.createdByUserId,
          });
        const row = updated[0];
        if (!row) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Plan update returned no row',
          });
        }

        if (datesToRemove.length > 0) {
          await tx
            .delete(mealPlanSlots)
            .where(
              and(
                eq(mealPlanSlots.planId, row.id),
                inArray(mealPlanSlots.date, datesToRemove.map(parseCivilDate)),
              ),
            );
        }
        if (datesToAdd.length > 0) {
          await generateEmptySlotsForDates(
            tx,
            row.id,
            datesToAdd.map(parseCivilDate),
            occasionIds,
          );
        }

        const refreshed = await selectPlanSlots(tx, row.id);
        return { plan: toPlanDto(row), slots: refreshed };
      });

      return { ...plan, slots };
    }),

  duplicate: protectedProcedure
    .input(duplicatePlanInputSchema)
    .output(duplicatePlanResultSchema)
    .mutation(async ({ ctx, input }): Promise<DuplicatePlanResult> => {
      const newStart = parseCivilDate(input.newStartDate);

      const sourceRow = await loadHouseholdPlan(ctx.db, input.planId);

      // Duration is preserved exactly. `daysBetween` is 1-based inclusive, so
      // shifting `endDate` by `daysBetween - 1` keeps the same range length.
      const offsetDays = daysBetween(sourceRow.startDate, newStart) - 1;
      const newEnd = addDays(sourceRow.endDate, offsetDays);

      const today = todayInLondon();

      // Same overlap predicate as `create` (DEC-38): household-scoped, future
      // or active plans only, inclusive boundary.
      const conflicting = await ctx.db
        .select({ id: mealPlans.id })
        .from(mealPlans)
        .where(
          and(
            eq(mealPlans.householdId, CURRENT_HOUSEHOLD_ID),
            gte(mealPlans.endDate, today),
            sql`NOT (${mealPlans.endDate} < ${newStart} OR ${mealPlans.startDate} > ${newEnd})`,
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

      // Load source slots and build a source-date → new-date map by walking
      // both ranges in lockstep. Sidesteps per-slot arithmetic and keeps all
      // date math inside `eachDateInRange` / `addDays`.
      const sourceSlots = await ctx.db
        .select({
          date: mealPlanSlots.date,
          occasionId: mealPlanSlots.occasionId,
          slotType: mealPlanSlots.slotType,
          recipeId: mealPlanSlots.recipeId,
          numberOfServings: mealPlanSlots.numberOfServings,
          chefUserId: mealPlanSlots.chefUserId,
          cooksBaseRecipeId: mealPlanSlots.cooksBaseRecipeId,
          cooksBaseServings: mealPlanSlots.cooksBaseServings,
          comment: mealPlanSlots.comment,
        })
        .from(mealPlanSlots)
        .where(eq(mealPlanSlots.planId, sourceRow.id));

      const sourceDates = eachDateInRange(
        sourceRow.startDate,
        sourceRow.endDate,
      );
      const newDates = eachDateInRange(newStart, newEnd);
      const dateMap = new Map<string, Date>();
      for (let i = 0; i < sourceDates.length; i++) {
        const src = sourceDates[i];
        const next = newDates[i];
        if (!src || !next) continue;
        dateMap.set(formatCivilDate(src), next);
      }

      const withTransaction = makeWithTransaction(ctx.db);
      const { plan, slotCount } = await withTransaction(async (tx) => {
        const inserted = await tx
          .insert(mealPlans)
          .values({
            householdId: CURRENT_HOUSEHOLD_ID,
            createdByUserId: ctx.user.id,
            startDate: newStart,
            endDate: newEnd,
          })
          .returning({
            id: mealPlans.id,
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

        if (sourceSlots.length === 0) {
          return { plan: toPlanDto(row), slotCount: 0 };
        }

        const slotValues = sourceSlots.map((slot) => {
          const shifted = dateMap.get(formatCivilDate(slot.date));
          if (!shifted) {
            // Source slot dates always fall within the source range so the
            // map lookup never misses; this guard is defence-in-depth.
            throw new TRPCError({
              code: 'INTERNAL_SERVER_ERROR',
              message: 'Slot date outside source plan range',
            });
          }
          return {
            planId: row.id,
            date: shifted,
            occasionId: slot.occasionId,
            slotType: slot.slotType,
            recipeId: slot.recipeId,
            numberOfServings: slot.numberOfServings,
            chefUserId: slot.chefUserId,
            cooksBaseRecipeId: slot.cooksBaseRecipeId,
            cooksBaseServings: slot.cooksBaseServings,
            comment: slot.comment,
          };
        });

        const insertedSlots = await tx
          .insert(mealPlanSlots)
          .values(slotValues)
          .returning({ id: mealPlanSlots.id });

        return { plan: toPlanDto(row), slotCount: insertedSlots.length };
      });

      return { plan, slotCount };
    }),
});

interface PlanRow {
  id: number;
  startDate: Date;
  endDate: Date;
  createdByUserId: string | null;
}

function toPlanDto(row: PlanRow): Plan {
  return planSchema.parse({
    id: row.id,
    startDate: formatCivilDate(row.startDate),
    endDate: formatCivilDate(row.endDate),
    createdByUserId: row.createdByUserId,
  });
}

async function loadHouseholdPlan(db: DbHandle, id: number): Promise<PlanRow> {
  const rows = await db
    .select({
      id: mealPlans.id,
      startDate: mealPlans.startDate,
      endDate: mealPlans.endDate,
      createdByUserId: mealPlans.createdByUserId,
    })
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
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Plan not found',
    });
  }
  return row;
}

async function loadOccasionIds(db: DbHandle): Promise<number[]> {
  const rows = await db
    .select({ id: mealOccasions.id })
    .from(mealOccasions)
    .orderBy(asc(mealOccasions.id));
  if (rows.length === 0) {
    // Reference data ships in the seed (`MEAL_OCCASIONS`); an empty
    // table means deployment misconfiguration, not user error.
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'No meal occasions configured',
    });
  }
  return rows.map((row) => row.id);
}

// LEFT JOIN recipes without an `is_deleted` filter so historical slots
// referencing soft-deleted recipes still render (DEC-21). meal_occasions
// join provides the occasion name for the UI to label columns.
async function selectPlanSlots(
  db: DbHandle,
  planId: number,
): Promise<PlanSlot[]> {
  const cookedBase = alias(recipes, 'cooked_base_recipe');
  const rows = await db
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
      comment: mealPlanSlots.comment,
      recipeName: recipes.name,
      recipeImageUrl: recipes.imageUrl,
      recipeIsBase: recipes.isBase,
      recipeBaseRecipeId: recipes.baseRecipeId,
      recipeIsDeleted: recipes.isDeleted,
      cookedBaseName: cookedBase.name,
      cookedBaseIsDeleted: cookedBase.isDeleted,
    })
    .from(mealPlanSlots)
    .innerJoin(mealOccasions, eq(mealPlanSlots.occasionId, mealOccasions.id))
    .leftJoin(recipes, eq(mealPlanSlots.recipeId, recipes.id))
    .leftJoin(cookedBase, eq(mealPlanSlots.cooksBaseRecipeId, cookedBase.id))
    .where(eq(mealPlanSlots.planId, planId))
    .orderBy(asc(mealPlanSlots.date), asc(mealPlanSlots.occasionId));

  return rows.map((row) => ({
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
    comment: row.comment,
    recipe:
      row.recipeId === null || row.recipeName === null
        ? null
        : {
            id: row.recipeId,
            name: row.recipeName,
            imageUrl: row.recipeImageUrl,
            isBase: row.recipeIsBase ?? false,
            baseRecipeId: row.recipeBaseRecipeId ?? null,
            isDeleted: row.recipeIsDeleted ?? false,
          },
    cooksBaseRecipe:
      row.cooksBaseRecipeId === null || row.cookedBaseName === null
        ? null
        : {
            id: row.cooksBaseRecipeId,
            name: row.cookedBaseName,
            isDeleted: row.cookedBaseIsDeleted ?? false,
          },
  }));
}
