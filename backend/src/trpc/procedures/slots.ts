import { TRPCError } from '@trpc/server';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import {
  relocateSlotInputSchema,
  relocateSlotResultSchema,
  storeSlotItemInputSchema,
  storeSlotItemResultSchema,
  updateSlotInputSchema,
  updateSlotResultSchema,
  type PlanSlot,
  type RelocateSlotResult,
  type StoredLimit,
  type StoreSlotItemResult,
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
import {
  moveSlotItems,
  reconcileSlotItems,
  replaceSlotDiners,
} from '../../lib/slot-writes.ts';
import { changeStored } from '../../lib/slot-storing.ts';
import { settleReservations } from '../../lib/stock-settlement.ts';
import { loadSlotItems } from '../../lib/slot-items.ts';
import { makeWithTransaction, type Tx } from '../../db/withTransaction.ts';
import { formatCivilDate, todayInLondon } from '../../lib/date-utils.ts';
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
      // caller is *adding*. New items must reference a pickable recipe; any
      // recipe may be over-cooked now, so there's no base-only restriction
      // (DEC-91 dropped the cook-ahead-must-be-a-base rule).
      const existingRecipeIds = await loadSlotItemRecipeIds(ctx.db, slot.id);
      for (const item of input.items) {
        if (existingRecipeIds.has(item.recipeId)) continue;
        await assertRecipeAssignable(ctx.db, item.recipeId);
      }

      if (input.chefUserId !== null) {
        await assertUserExists(ctx.db, input.chefUserId, 'SLOT_CHEF_NOT_FOUND');
      }
      for (const dinerUserId of input.dinerUserIds) {
        await assertUserExists(ctx.db, dinerUserId, 'SLOT_DINER_NOT_FOUND');
      }

      const today = todayInLondon();
      const withTransaction = makeWithTransaction(ctx.db);
      const storedLimits = await withTransaction(async (tx) => {
        await tx
          .update(mealPlanSlots)
          .set({
            slotType: input.slotType,
            leftoversSource: input.leftoversSource,
            chefUserId: input.chefUserId,
            comment: input.comment,
            guestCount: input.guestCount,
          })
          .where(eq(mealPlanSlots.id, slot.id));
        const limits = await reconcileSlotItems(
          tx,
          slot.id,
          input.items,
          today,
        );
        await replaceSlotDiners(tx, slot.id, input.dinerUserIds);
        return limits;
      });

      const selected = await selectSlotById(ctx.db, slot.id);
      return { slot: selected, storedLimits };
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
        // Lock both slot rows, lowest id first, before their dishes: a slot
        // save locks its slot row before its items, so taking the same order
        // here can't deadlock against it or against an opposite drag.
        await tx
          .select({ id: mealPlanSlots.id })
          .from(mealPlanSlots)
          .where(inArray(mealPlanSlots.id, [source.id, dest.id]))
          .orderBy(asc(mealPlanSlots.id))
          .for('update');
        const [sourceItemIds, destItemIds, sourceDiners, destDiners] =
          await Promise.all([
            loadSlotItemIds(tx, source.id),
            loadSlotItemIds(tx, dest.id),
            loadRawSlotDiners(tx, source.id),
            loadRawSlotDiners(tx, dest.id),
          ]);
        const destPopulated =
          dest.slotType !== 'empty' || destItemIds.length > 0;

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

        // Dishes move by id, so what was stored from them stays linked.
        await moveSlotItems(tx, sourceItemIds, dest.id);
        await moveSlotItems(tx, destItemIds, source.id);

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

  // FEAT-79 — "Store…" on a slot card: set a dish's Freezer and Fridge counts.
  // Works on any day, past ones included. Raising a count makes a Stock item;
  // lowering one takes back linked portions still held and unreserved, and
  // stops where it can't (reported in `storedLimits`).
  store: protectedProcedure
    .input(storeSlotItemInputSchema)
    .output(storeSlotItemResultSchema)
    .mutation(async ({ ctx, input }): Promise<StoreSlotItemResult> => {
      const today = todayInLondon();
      const withTransaction = makeWithTransaction(ctx.db);
      const { slotId, storedLimits } = await withTransaction(async (tx) => {
        const item = await loadHouseholdSlotItemForUpdate(tx, input.slotItemId);
        if (item.eaten + input.frozen + input.chilled > item.prepared) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'More portions than this dish has spare',
            cause: {
              code: 'SLOT_ITEM_STORE_EXCEEDS_SPARE',
              spare: item.prepared - item.eaten,
            },
          });
        }
        if (input.frozen < item.frozen || input.chilled < item.chilled) {
          await settleReservations(tx, today);
        }
        // Lowerings run first: a count that can't all come back keeps its
        // room, and a raise of the other count only takes what's left.
        const limits: StoredLimit[] = [];
        const counts = { frozen: item.frozen, chilled: item.chilled };
        const keys = (
          [
            ['frozen', 'freezer'],
            ['chilled', 'fridge'],
          ] as const
        )
          .slice()
          .sort(
            ([a], [b]) =>
              Number(input[a] > item[a]) - Number(input[b] > item[b]),
          );
        for (const [key, location] of keys) {
          const other = key === 'frozen' ? counts.chilled : counts.frozen;
          const room = item.prepared - item.eaten - other;
          const target =
            input[key] > item[key] ? Math.min(input[key], room) : input[key];
          const reached = await changeStored(
            tx,
            {
              slotItemId: item.id,
              recipeId: item.recipeId,
              location,
              from: item[key],
              to: target,
            },
            today,
          );
          if (reached !== input[key]) {
            limits.push({
              slotItemId: item.id,
              location,
              requested: input[key],
              applied: reached,
            });
          }
          counts[key] = reached;
        }
        await tx
          .update(mealPlanSlotItems)
          .set(counts)
          .where(eq(mealPlanSlotItems.id, item.id));
        return { slotId: item.slotId, storedLimits: limits };
      });
      const slot = await selectSlotById(ctx.db, slotId);
      return { slot, storedLimits };
    }),
});

interface SlotMeta {
  id: number;
  planId: number;
  slotType: typeof mealPlanSlots.$inferSelect.slotType;
  leftoversSource: typeof mealPlanSlots.$inferSelect.leftoversSource;
  chefUserId: string | null;
  comment: string | null;
  guestCount: number;
}

type MetaPatch = Pick<
  SlotMeta,
  'slotType' | 'leftoversSource' | 'chefUserId' | 'comment' | 'guestCount'
>;

function metaPatch(slot: SlotMeta): MetaPatch {
  return {
    slotType: slot.slotType,
    leftoversSource: slot.leftoversSource,
    chefUserId: slot.chefUserId,
    comment: slot.comment,
    guestCount: slot.guestCount,
  };
}

function emptyMetaPatch(): MetaPatch {
  return {
    slotType: 'empty',
    leftoversSource: null,
    chefUserId: null,
    comment: null,
    guestCount: 0,
  };
}

async function loadSlotItemIds(tx: Tx, slotId: number): Promise<number[]> {
  const rows = await tx
    .select({ id: mealPlanSlotItems.id })
    .from(mealPlanSlotItems)
    .where(eq(mealPlanSlotItems.slotId, slotId))
    .for('update');
  return rows.map((row) => row.id);
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

async function loadHouseholdSlotItemForUpdate(
  tx: Tx,
  slotItemId: number,
): Promise<{
  id: number;
  slotId: number;
  recipeId: number;
  prepared: number;
  eaten: number;
  frozen: number;
  chilled: number;
}> {
  const rows = await tx
    .select({
      id: mealPlanSlotItems.id,
      slotId: mealPlanSlotItems.slotId,
      recipeId: mealPlanSlotItems.recipeId,
      prepared: mealPlanSlotItems.prepared,
      eaten: mealPlanSlotItems.eaten,
      frozen: mealPlanSlotItems.frozen,
      chilled: mealPlanSlotItems.chilled,
    })
    .from(mealPlanSlotItems)
    .innerJoin(mealPlanSlots, eq(mealPlanSlotItems.slotId, mealPlanSlots.id))
    .innerJoin(mealPlans, eq(mealPlanSlots.planId, mealPlans.id))
    .where(
      and(
        eq(mealPlanSlotItems.id, slotItemId),
        eq(mealPlans.householdId, CURRENT_HOUSEHOLD_ID),
      ),
    )
    .for('update', { of: mealPlanSlotItems });
  const row = rows[0];
  if (!row) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Dish not found',
      cause: { code: 'SLOT_ITEM_NOT_FOUND' },
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
      leftoversSource: mealPlanSlots.leftoversSource,
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
      leftoversSource: mealPlanSlots.leftoversSource,
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
    leftoversSource: row.leftoversSource,
    chefUserId: row.chefUserId,
    comment: row.comment,
    items,
    dinerUserIds,
    guestCount: row.guestCount,
  };
}
