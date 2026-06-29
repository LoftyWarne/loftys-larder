import { TRPCError } from '@trpc/server';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import {
  relocateSlotInputSchema,
  relocateSlotResultSchema,
  updateSlotInputSchema,
  updateSlotResultSchema,
  type PlanSlot,
  type RelocateSlotResult,
  type SlotItemInput,
  type UpdateSlotResult,
} from '../../../../shared/src/index.ts';
import { CURRENT_HOUSEHOLD_ID } from '../../config.ts';
import { users } from '../../db/schema/auth.ts';
import * as schema from '../../db/schema/index.ts';
import {
  mealPlans,
  mealPlanSlotDiners,
  mealPlanSlotItems,
  mealPlanSlots,
} from '../../db/schema/meal-plans.ts';
import { recipes } from '../../db/schema/recipes.ts';
import { mealOccasions } from '../../db/schema/reference.ts';
import { loadSlotDiners } from '../../lib/slot-diners.ts';
import { loadSlotItems } from '../../lib/slot-items.ts';
import { makeWithTransaction, type Tx } from '../../db/withTransaction.ts';
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
      const slot = await loadHouseholdSlotId(ctx.db, input.slotId);

      // Coherence rule (DEC-21): a recipe already on the slot can stay even if
      // it was soft-deleted after assignment, so only validate recipes the
      // caller is *adding*. New `eat` items must be pickable; new `cook_ahead`
      // items must reference a non-deleted base.
      const existingRecipeIds = await loadSlotItemRecipeIds(ctx.db, slot.id);
      for (const item of input.items) {
        if (existingRecipeIds.has(item.recipeId)) continue;
        if (item.kind === 'cook_ahead') {
          await assertRecipeIsBase(ctx.db, item.recipeId);
        } else {
          await assertRecipeAssignable(ctx.db, item.recipeId);
        }
      }

      if (input.chefUserId !== null) {
        await assertUserExists(ctx.db, input.chefUserId, 'SLOT_CHEF_NOT_FOUND');
      }
      for (const dinerUserId of input.dinerUserIds) {
        await assertUserExists(ctx.db, dinerUserId, 'SLOT_DINER_NOT_FOUND');
      }

      const withTransaction = makeWithTransaction(ctx.db);
      await withTransaction(async (tx) => {
        await tx
          .update(mealPlanSlots)
          .set({
            slotType: input.slotType,
            chefUserId: input.chefUserId,
            comment: input.comment,
            guestCount: input.guestCount,
          })
          .where(eq(mealPlanSlots.id, slot.id));
        await replaceSlotItems(tx, slot.id, input.items);
        await replaceSlotDiners(tx, slot.id, input.dinerUserIds);
      });

      const selected = await selectSlotById(ctx.db, slot.id);
      return { slot: selected };
    }),

  // FEAT-40 — drag a slot onto another slot. Empty dest = move (source goes
  // empty). Populated dest = swap (contents exchange). Both writes happen
  // inside one transaction (cross-cutting #4) so the two slots are never
  // observed mid-exchange. Same scope discipline as `update`. Both slots must
  // belong to the same plan; cross-plan drops fail with FORBIDDEN.
  relocate: protectedProcedure
    .input(relocateSlotInputSchema)
    .output(relocateSlotResultSchema)
    .mutation(async ({ ctx, input }): Promise<RelocateSlotResult> => {
      const withTransaction = makeWithTransaction(ctx.db);
      const { sourceSlotId, destSlotId } = await withTransaction(async (tx) => {
        const [source, dest] = await Promise.all([
          loadHouseholdSlotContent(tx, input.sourceSlotId),
          loadHouseholdSlotContent(tx, input.destSlotId),
        ]);
        if (source.planId !== dest.planId) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Cannot relocate a slot across plans',
            cause: { code: 'SLOT_RELOCATE_CROSS_PLAN' },
          });
        }
        const [sourceItems, destItems, sourceDiners, destDiners] =
          await Promise.all([
            loadRawSlotItems(tx, source.id),
            loadRawSlotItems(tx, dest.id),
            loadRawSlotDiners(tx, source.id),
            loadRawSlotDiners(tx, dest.id),
          ]);
        const destPopulated = dest.slotType !== 'empty' || destItems.length > 0;

        // Dest receives source's content unconditionally; source receives
        // dest's content (swap) or is emptied (move).
        await tx
          .update(mealPlanSlots)
          .set(metaPatch(source))
          .where(eq(mealPlanSlots.id, dest.id));
        await tx
          .update(mealPlanSlots)
          .set(destPopulated ? metaPatch(dest) : emptyMetaPatch())
          .where(eq(mealPlanSlots.id, source.id));

        await tx
          .delete(mealPlanSlotItems)
          .where(inArray(mealPlanSlotItems.slotId, [source.id, dest.id]));
        await replaceSlotItems(tx, dest.id, sourceItems);
        if (destPopulated) {
          await replaceSlotItems(tx, source.id, destItems);
        }

        // Diners ride along with the slot's content (the "who's eating" set).
        await tx
          .delete(mealPlanSlotDiners)
          .where(inArray(mealPlanSlotDiners.slotId, [source.id, dest.id]));
        await replaceSlotDiners(tx, dest.id, sourceDiners);
        if (destPopulated) {
          await replaceSlotDiners(tx, source.id, destDiners);
        }

        return { sourceSlotId: source.id, destSlotId: dest.id };
      });
      const [sourceSlot, destSlot] = await Promise.all([
        selectSlotById(ctx.db, sourceSlotId),
        selectSlotById(ctx.db, destSlotId),
      ]);
      return { sourceSlot, destSlot };
    }),
});

interface SlotMeta {
  id: number;
  planId: number;
  slotType: typeof mealPlanSlots.$inferSelect.slotType;
  chefUserId: string | null;
  comment: string | null;
  guestCount: number;
}

type MetaPatch = Pick<
  SlotMeta,
  'slotType' | 'chefUserId' | 'comment' | 'guestCount'
>;

function metaPatch(slot: SlotMeta): MetaPatch {
  return {
    slotType: slot.slotType,
    chefUserId: slot.chefUserId,
    comment: slot.comment,
    guestCount: slot.guestCount,
  };
}

function emptyMetaPatch(): MetaPatch {
  return { slotType: 'empty', chefUserId: null, comment: null, guestCount: 0 };
}

// Replace the slot's items with `items`, reinserting in the given order. The
// caller is responsible for having deleted any prior rows (relocate batches the
// delete across both slots; update relies on this helper's own delete).
async function replaceSlotItems(
  tx: Tx,
  slotId: number,
  items: readonly SlotItemInput[],
): Promise<void> {
  await tx
    .delete(mealPlanSlotItems)
    .where(eq(mealPlanSlotItems.slotId, slotId));
  if (items.length === 0) return;
  await tx.insert(mealPlanSlotItems).values(
    items.map((item) => ({
      slotId,
      recipeId: item.recipeId,
      servings: item.servings,
      kind: item.kind,
      sortOrder: item.sortOrder,
    })),
  );
}

interface RawSlotItem {
  recipeId: number;
  servings: number;
  kind: typeof mealPlanSlotItems.$inferSelect.kind;
  sortOrder: number;
}

async function loadRawSlotItems(
  tx: Tx,
  slotId: number,
): Promise<RawSlotItem[]> {
  return tx
    .select({
      recipeId: mealPlanSlotItems.recipeId,
      servings: mealPlanSlotItems.servings,
      kind: mealPlanSlotItems.kind,
      sortOrder: mealPlanSlotItems.sortOrder,
    })
    .from(mealPlanSlotItems)
    .where(eq(mealPlanSlotItems.slotId, slotId))
    .orderBy(asc(mealPlanSlotItems.sortOrder), asc(mealPlanSlotItems.id));
}

// Replace the slot's named diners with `userIds`. Like `replaceSlotItems`, the
// caller may have batch-deleted prior rows already (relocate does); this helper
// also clears the slot's own rows so `update` can call it standalone.
async function replaceSlotDiners(
  tx: Tx,
  slotId: number,
  userIds: readonly string[],
): Promise<void> {
  await tx
    .delete(mealPlanSlotDiners)
    .where(eq(mealPlanSlotDiners.slotId, slotId));
  if (userIds.length === 0) return;
  await tx
    .insert(mealPlanSlotDiners)
    .values(userIds.map((userId) => ({ slotId, userId })));
}

async function loadRawSlotDiners(tx: Tx, slotId: number): Promise<string[]> {
  const rows = await tx
    .select({ userId: mealPlanSlotDiners.userId })
    .from(mealPlanSlotDiners)
    .where(eq(mealPlanSlotDiners.slotId, slotId))
    .orderBy(asc(mealPlanSlotDiners.userId));
  return rows.map((row) => row.userId);
}

async function loadSlotItemRecipeIds(
  db: DbHandle,
  slotId: number,
): Promise<Set<number>> {
  const rows = await db
    .select({ recipeId: mealPlanSlotItems.recipeId })
    .from(mealPlanSlotItems)
    .where(eq(mealPlanSlotItems.slotId, slotId));
  return new Set(rows.map((row) => row.recipeId));
}

async function loadHouseholdSlotId(
  db: DbHandle,
  slotId: number,
): Promise<{ id: number }> {
  const rows = await db
    .select({ id: mealPlanSlots.id })
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

async function loadHouseholdSlotContent(
  db: DbHandle,
  slotId: number,
): Promise<SlotMeta> {
  const rows = await db
    .select({
      id: mealPlanSlots.id,
      planId: mealPlanSlots.planId,
      slotType: mealPlanSlots.slotType,
      chefUserId: mealPlanSlots.chefUserId,
      comment: mealPlanSlots.comment,
      guestCount: mealPlanSlots.guestCount,
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
      message: 'A cook-ahead item must reference a base recipe',
      cause: { code: 'SLOT_ITEM_COOK_AHEAD_NOT_BASE' },
    });
  }
}

async function assertUserExists(
  db: DbHandle,
  userId: string,
  code: 'SLOT_CHEF_NOT_FOUND' | 'SLOT_DINER_NOT_FOUND',
): Promise<void> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!rows[0]) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message:
        code === 'SLOT_CHEF_NOT_FOUND'
          ? 'Chef user not found'
          : 'Diner user not found',
      cause: { code },
    });
  }
}

// Mirrors `selectPlanSlots` in plans.ts but for a single slot — the planner UI
// reads the same shape after a mutation, so the optimistic cache can swap in
// the server-returned row without re-fetching the whole plan.
async function selectSlotById(db: DbHandle, slotId: number): Promise<PlanSlot> {
  const rows = await db
    .select({
      id: mealPlanSlots.id,
      planId: mealPlanSlots.planId,
      date: mealPlanSlots.date,
      occasionId: mealPlanSlots.occasionId,
      occasionName: mealOccasions.name,
      slotType: mealPlanSlots.slotType,
      chefUserId: mealPlanSlots.chefUserId,
      comment: mealPlanSlots.comment,
      guestCount: mealPlanSlots.guestCount,
    })
    .from(mealPlanSlots)
    .innerJoin(mealOccasions, eq(mealPlanSlots.occasionId, mealOccasions.id))
    .where(eq(mealPlanSlots.id, slotId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Updated slot not found on re-select',
    });
  }
  const items = (await loadSlotItems(db, [slotId])).get(slotId) ?? [];
  const dinerUserIds = (await loadSlotDiners(db, [slotId])).get(slotId) ?? [];
  return {
    id: row.id,
    planId: row.planId,
    date: formatCivilDate(row.date),
    occasionId: row.occasionId,
    occasionName: row.occasionName,
    slotType: row.slotType,
    chefUserId: row.chefUserId,
    comment: row.comment,
    items,
    dinerUserIds,
    guestCount: row.guestCount,
  };
}
