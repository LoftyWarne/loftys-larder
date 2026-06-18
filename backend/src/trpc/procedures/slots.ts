import { TRPCError } from '@trpc/server';
import { and, asc, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { alias } from 'drizzle-orm/pg-core';

import {
  updateSlotInputSchema,
  updateSlotResultSchema,
  type PlanSlot,
  type UpdateSlotResult,
} from '../../../../shared/src/index.ts';
import { CURRENT_HOUSEHOLD_ID } from '../../config.ts';
import { users } from '../../db/schema/auth.ts';
import * as schema from '../../db/schema/index.ts';
import { mealPlans, mealPlanSlots } from '../../db/schema/meal-plans.ts';
import { recipes } from '../../db/schema/recipes.ts';
import { mealOccasions } from '../../db/schema/reference.ts';
import type { Tx } from '../../db/withTransaction.ts';
import { formatCivilDate } from '../../lib/date-utils.ts';
import { protectedProcedure, router } from '../init.ts';

type Schema = typeof schema;
type DbHandle = NodePgDatabase<Schema> | Tx;

export const slotsRouter = router({
  update: protectedProcedure
    .input(updateSlotInputSchema)
    .output(updateSlotResultSchema)
    .mutation(async ({ ctx, input }): Promise<UpdateSlotResult> => {
      // Load the slot through its plan so household scope (DEC-17) is enforced
      // even though `meal_plan_slots` has no direct household_id column.
      const existing = await loadHouseholdSlot(ctx.db, input.slotId);

      // Recipe pickability is the one validation that depends on the input
      // *changing* the slot's recipe: a slot already pointing at a soft-deleted
      // recipe can keep its existing assignment when the caller is just
      // editing servings/comment/etc. (DEC-21 historical-render coherence).
      if (input.slotType === 'recipe' && input.recipeId !== null) {
        const recipeChanged = input.recipeId !== existing.recipeId;
        if (recipeChanged) {
          await assertRecipeAssignable(ctx.db, input.recipeId);
        }
      }

      // Same coherence rule for the base-cook FK: only re-validate when the
      // caller is *changing* it, so a historical slot whose cooked base was
      // later soft-deleted can still be edited (DEC-21).
      if (input.cooksBaseRecipeId !== null) {
        const baseChanged =
          input.cooksBaseRecipeId !== existing.cooksBaseRecipeId;
        if (baseChanged) {
          await assertRecipeIsBase(ctx.db, input.cooksBaseRecipeId);
        }
      }

      if (input.chefUserId !== null) {
        await assertUserExists(ctx.db, input.chefUserId);
      }

      // Joint-set CHECK on (recipe_id, number_of_servings) is enforced both
      // here and by the DB; the schema refine on the input has already
      // guaranteed the pairing, so the UPDATE writes a coherent row.
      const updated = await ctx.db
        .update(mealPlanSlots)
        .set({
          slotType: input.slotType,
          recipeId: input.recipeId,
          numberOfServings: input.numberOfServings,
          chefUserId: input.chefUserId,
          cooksBaseRecipeId: input.cooksBaseRecipeId,
          cooksBaseServings: input.cooksBaseServings,
          comment: input.comment,
        })
        .where(eq(mealPlanSlots.id, existing.id))
        .returning({ id: mealPlanSlots.id });

      if (!updated[0]) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Slot update returned no row',
        });
      }

      const slot = await selectSlotById(ctx.db, existing.id);
      return { slot };
    }),
});

interface ExistingSlot {
  id: number;
  recipeId: number | null;
  cooksBaseRecipeId: number | null;
}

async function loadHouseholdSlot(
  db: DbHandle,
  slotId: number,
): Promise<ExistingSlot> {
  const rows = await db
    .select({
      id: mealPlanSlots.id,
      recipeId: mealPlanSlots.recipeId,
      cooksBaseRecipeId: mealPlanSlots.cooksBaseRecipeId,
    })
    .from(mealPlanSlots)
    .innerJoin(mealPlans, eq(mealPlanSlots.planId, mealPlans.id))
    .where(
      and(
        eq(mealPlanSlots.id, slotId),
        eq(mealPlans.householdId, CURRENT_HOUSEHOLD_ID),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Slot not found',
      cause: { code: 'SLOT_NOT_FOUND' },
    });
  }
  return row;
}

async function assertRecipeAssignable(
  db: DbHandle,
  recipeId: number,
): Promise<void> {
  const rows = await db
    .select({
      householdId: recipes.householdId,
      isDeleted: recipes.isDeleted,
    })
    .from(recipes)
    .where(eq(recipes.id, recipeId))
    .limit(1);
  const row = rows[0];
  if (row?.householdId !== CURRENT_HOUSEHOLD_ID) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Recipe not available in this household',
      cause: { code: 'SLOT_RECIPE_CROSS_HOUSEHOLD' },
    });
  }
  if (row.isDeleted) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Recipe is deleted and cannot be assigned',
      cause: { code: 'SLOT_RECIPE_NOT_PICKABLE' },
    });
  }
}

async function assertRecipeIsBase(
  db: DbHandle,
  recipeId: number,
): Promise<void> {
  const rows = await db
    .select({
      householdId: recipes.householdId,
      isDeleted: recipes.isDeleted,
      isBase: recipes.isBase,
    })
    .from(recipes)
    .where(eq(recipes.id, recipeId))
    .limit(1);
  const row = rows[0];
  if (row?.householdId !== CURRENT_HOUSEHOLD_ID) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Base recipe not available in this household',
      cause: { code: 'SLOT_BASE_CROSS_HOUSEHOLD' },
    });
  }
  if (row.isDeleted) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Base recipe is deleted and cannot be assigned',
      cause: { code: 'SLOT_BASE_NOT_PICKABLE' },
    });
  }
  if (!row.isBase) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'cooksBaseRecipeId must reference a base recipe',
      cause: { code: 'SLOT_BASE_NOT_BASE' },
    });
  }
}

async function assertUserExists(db: DbHandle, userId: string): Promise<void> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!rows[0]) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Chef user not found',
      cause: { code: 'SLOT_CHEF_NOT_FOUND' },
    });
  }
}

// Mirrors `selectPlanSlots` in plans.ts but for a single slot — the planner UI
// reads the same shape after a mutation, so the optimistic cache can swap in
// the server-returned row without re-fetching the whole plan.
async function selectSlotById(db: DbHandle, slotId: number): Promise<PlanSlot> {
  const cookedBase = alias(recipes, 'cooked_base_recipe');
  const pairedRecipe = alias(recipes, 'paired_recipe');
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
      recipePairedRecipeId: recipes.pairedRecipeId,
      recipeIsDeleted: recipes.isDeleted,
      cookedBaseName: cookedBase.name,
      cookedBaseIsDeleted: cookedBase.isDeleted,
      pairedRecipeId: pairedRecipe.id,
      pairedRecipeName: pairedRecipe.name,
      pairedRecipeImageUrl: pairedRecipe.imageUrl,
      pairedRecipeIsBase: pairedRecipe.isBase,
      pairedRecipeBaseRecipeId: pairedRecipe.baseRecipeId,
      pairedRecipeBaseServings: pairedRecipe.baseServings,
      pairedRecipeIsDeleted: pairedRecipe.isDeleted,
    })
    .from(mealPlanSlots)
    .innerJoin(mealOccasions, eq(mealPlanSlots.occasionId, mealOccasions.id))
    .leftJoin(recipes, eq(mealPlanSlots.recipeId, recipes.id))
    .leftJoin(cookedBase, eq(mealPlanSlots.cooksBaseRecipeId, cookedBase.id))
    .leftJoin(pairedRecipe, eq(recipes.pairedRecipeId, pairedRecipe.id))
    .where(eq(mealPlanSlots.id, slotId))
    .orderBy(asc(mealPlanSlots.id))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Updated slot not found on re-select',
    });
  }
  return {
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
            pairedRecipeId: row.recipePairedRecipeId ?? null,
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
    pairedRecipe:
      row.pairedRecipeId === null || row.pairedRecipeName === null
        ? null
        : {
            id: row.pairedRecipeId,
            name: row.pairedRecipeName,
            imageUrl: row.pairedRecipeImageUrl,
            isBase: row.pairedRecipeIsBase ?? false,
            baseRecipeId: row.pairedRecipeBaseRecipeId ?? null,
            baseServings: row.pairedRecipeBaseServings ?? 1,
            isDeleted: row.pairedRecipeIsDeleted ?? false,
          },
  };
}
