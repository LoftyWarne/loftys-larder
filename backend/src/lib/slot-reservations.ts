import { TRPCError } from '@trpc/server';
import { and, asc, eq, inArray, isNotNull, or, sql } from 'drizzle-orm';

import type {
  LeftoversSource,
  SlotItemInput,
  StorageLocation,
} from '../../../shared/src/index.ts';
import { CURRENT_HOUSEHOLD_ID } from '../config.ts';
import { mealPlanSlotItems, mealPlanSlots } from '../db/schema/meal-plans.ts';
import { recipes } from '../db/schema/recipes.ts';
import { stockItems, stockReservations } from '../db/schema/storage.ts';
import type { Tx } from '../db/withTransaction.ts';
import { formatCivilDate } from './date-utils.ts';
import {
  formatFixed3FromMilli,
  parseMilliFromFixed3,
} from './shopping-aggregation.ts';
import {
  planDraws,
  planRelease,
  type HeldItem,
  type LineReservation,
} from './shopping-holdings.ts';

// A slot item's Reservations (DEC-118, FEAT-81): the Stock items a Leftovers
// from Storage dish eats, or a Variation's base taken from storage ("Use
// frozen base"). The slot item records how many portions it takes
// (`from_storage`); its Reservations are what's actually held for it.
//
// Lock order, as every storage write takes it: Reservations settled, then the
// plan and slot, then Stock items, then Reservations.

export interface SlotItemStorageNeed {
  slotItemId: number;
  // The recipe whose portions are held: the dish itself, or a Variation's base.
  targetRecipeId: number;
  portions: number;
  neededOn: Date;
  // Where the portions may come from. A base comes only from the Freezer or
  // the Fridge.
  locations: readonly StorageLocation[];
  // The picker entry the cook chose. When given, only these items are drawn
  // from, past Use-by or not. Otherwise past-Use-by Fridge items are skipped.
  stockItemIds?: readonly number[];
}

export const ALL_LOCATIONS: readonly StorageLocation[] = [
  'freezer',
  'fridge',
  'pantry',
];
export const BASE_LOCATIONS: readonly StorageLocation[] = ['freezer', 'fridge'];

// The recipe a dish's storage portions are of, by the rule the planner's
// balance uses: a cooked Variation takes its base; anything else, itself.
export function storageTargetRecipeId(item: {
  recipeId: number;
  prepared: number;
  baseRecipeId: number | null;
}): number {
  return item.prepared > 0 && item.baseRecipeId !== null
    ? item.baseRecipeId
    : item.recipeId;
}

export interface SlotStorageWrite {
  leftoversSource: LeftoversSource | null;
  items: readonly SlotItemInput[];
  // Each dish's id by recipe, as the slot write returned them.
  itemIds: ReadonlyMap<number, number>;
  date: Date;
}

// One need per dish on the slot, so a dish that stops taking from storage
// releases what it held. Only a Variation's base may come from storage on a
// cooked dish (`SLOT_FROM_STORAGE_NOT_VARIATION`); the schema has already
// checked the amounts.
export async function storageNeedsFor(
  tx: Tx,
  write: SlotStorageWrite,
): Promise<SlotItemStorageNeed[]> {
  const recipeIds = write.items.map((item) => item.recipeId);
  if (recipeIds.length === 0) return [];
  const rows = await tx
    .select({ id: recipes.id, baseRecipeId: recipes.baseRecipeId })
    .from(recipes)
    .where(
      and(
        inArray(recipes.id, recipeIds),
        eq(recipes.householdId, CURRENT_HOUSEHOLD_ID),
      ),
    );
  const baseOf = new Map(rows.map((row) => [row.id, row.baseRecipeId]));
  const fromStorageSlot = write.leftoversSource === 'storage';

  const needs: SlotItemStorageNeed[] = [];
  for (const item of write.items) {
    const slotItemId = write.itemIds.get(item.recipeId);
    if (slotItemId === undefined) continue;
    const portions = item.fromStorage ?? 0;
    if (fromStorageSlot) {
      needs.push({
        slotItemId,
        targetRecipeId: item.recipeId,
        portions,
        neededOn: write.date,
        locations: ALL_LOCATIONS,
        ...(item.stockItemIds && { stockItemIds: item.stockItemIds }),
      });
      continue;
    }
    const baseRecipeId = baseOf.get(item.recipeId) ?? null;
    if (portions > 0 && baseRecipeId === null) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Only a Variation’s base can come from storage',
        cause: {
          code: 'SLOT_FROM_STORAGE_NOT_VARIATION',
          recipeId: item.recipeId,
        },
      });
    }
    needs.push({
      slotItemId,
      targetRecipeId: baseRecipeId ?? item.recipeId,
      portions,
      neededOn: write.date,
      locations: BASE_LOCATIONS,
      ...(item.stockItemIds && { stockItemIds: item.stockItemIds }),
    });
  }
  return needs;
}

// Brings each slot item's Reservations in line with its need. A slot whose
// day has passed is left alone: its Reservations have settled, and reserving
// again would eat the food twice. Reserves what's available when there isn't
// enough; the planner shows the rest as a shortfall.
export async function reconcileSlotItemReservations(
  tx: Tx,
  planId: number,
  needs: readonly SlotItemStorageNeed[],
  today: Date,
): Promise<void> {
  const todayIso = formatCivilDate(today);
  const live = needs.filter(
    (need) => formatCivilDate(need.neededOn) >= todayIso,
  );
  if (live.length === 0) return;

  const slotItemIds = live.map((need) => need.slotItemId);
  const targetIds = [...new Set(live.map((need) => need.targetRecipeId))];

  // Every item these slot items could draw from or already hold.
  await tx
    .select({ id: stockItems.id })
    .from(stockItems)
    .where(
      and(
        eq(stockItems.householdId, CURRENT_HOUSEHOLD_ID),
        or(
          inArray(stockItems.recipeId, targetIds),
          inArray(
            stockItems.id,
            tx
              .select({ id: stockReservations.stockItemId })
              .from(stockReservations)
              .where(
                and(
                  eq(stockReservations.householdId, CURRENT_HOUSEHOLD_ID),
                  inArray(stockReservations.slotItemId, slotItemIds),
                ),
              ),
          ),
        ),
      ),
    )
    .orderBy(asc(stockItems.id))
    .for('update');

  for (const need of live) {
    await reconcileOne(tx, planId, need, todayIso);
  }
}

async function reconcileOne(
  tx: Tx,
  planId: number,
  need: SlotItemStorageNeed,
  todayIso: string,
): Promise<void> {
  const existing = await tx
    .select({
      id: stockReservations.id,
      stockItemId: stockReservations.stockItemId,
      amount: stockReservations.amount,
      recipeId: stockItems.recipeId,
      location: stockItems.location,
    })
    .from(stockReservations)
    .innerJoin(stockItems, eq(stockItems.id, stockReservations.stockItemId))
    .where(
      and(
        eq(stockReservations.householdId, CURRENT_HOUSEHOLD_ID),
        eq(stockReservations.slotItemId, need.slotItemId),
      ),
    );

  const chosen = need.stockItemIds ? new Set(need.stockItemIds) : null;
  const fits = (row: (typeof existing)[number]): boolean =>
    need.portions > 0 &&
    row.recipeId === need.targetRecipeId &&
    need.locations.includes(row.location) &&
    (chosen === null || chosen.has(row.stockItemId));
  const releaseIds = existing.filter((row) => !fits(row)).map((row) => row.id);
  const kept = existing.filter(fits);

  const candidates = await loadCandidates(tx, need, todayIso);
  const neededMilli = BigInt(need.portions) * 1000n;
  const keptReservations: LineReservation[] = kept.map((row) => ({
    id: row.id,
    stockItemId: row.stockItemId,
    amountMilli: parseMilliFromFixed3(row.amount),
  }));
  const keptMilli = keptReservations.reduce(
    (sum, row) => sum + row.amountMilli,
    0n,
  );

  const lower: { id: number; amountMilli: bigint }[] = [];
  const raise = new Map<number, bigint>();
  const insert: { stockItemId: number; amountMilli: bigint }[] = [];
  if (keptMilli > neededMilli) {
    const release = planRelease(
      keptReservations,
      candidates,
      keptMilli - neededMilli,
    );
    releaseIds.push(...release.deleteIds);
    lower.push(...release.lower);
  } else if (keptMilli < neededMilli) {
    const ownByItem = new Map<number, number>();
    for (const row of keptReservations) ownByItem.set(row.stockItemId, row.id);
    for (const draw of planDraws(candidates, neededMilli - keptMilli)) {
      const own = ownByItem.get(draw.stockItemId);
      if (own === undefined) insert.push(draw);
      else raise.set(own, draw.amountMilli);
    }
  }

  if (releaseIds.length > 0) {
    await tx
      .delete(stockReservations)
      .where(
        and(
          eq(stockReservations.householdId, CURRENT_HOUSEHOLD_ID),
          inArray(stockReservations.id, releaseIds),
        ),
      );
  }
  for (const { id, amountMilli } of lower) {
    await tx
      .update(stockReservations)
      .set({ amount: formatFixed3FromMilli(amountMilli) })
      .where(
        and(
          eq(stockReservations.id, id),
          eq(stockReservations.householdId, CURRENT_HOUSEHOLD_ID),
        ),
      );
  }
  for (const [id, extraMilli] of raise) {
    await tx
      .update(stockReservations)
      .set({
        amount: sql`${stockReservations.amount} + ${formatFixed3FromMilli(extraMilli)}::numeric`,
      })
      .where(
        and(
          eq(stockReservations.id, id),
          eq(stockReservations.householdId, CURRENT_HOUSEHOLD_ID),
        ),
      );
  }
  if (insert.length > 0) {
    await tx.insert(stockReservations).values(
      insert.map((draw) => ({
        householdId: CURRENT_HOUSEHOLD_ID,
        stockItemId: draw.stockItemId,
        planId,
        slotItemId: need.slotItemId,
        amount: formatFixed3FromMilli(draw.amountMilli),
        neededOn: need.neededOn,
      })),
    );
  }
  await tx
    .update(stockReservations)
    .set({ neededOn: need.neededOn })
    .where(
      and(
        eq(stockReservations.householdId, CURRENT_HOUSEHOLD_ID),
        eq(stockReservations.slotItemId, need.slotItemId),
      ),
    );
}

// The items a need may draw from, with everything already reserved on them
// (this slot item's share included) counted as taken, so `planDraws` only
// takes what's free.
async function loadCandidates(
  tx: Tx,
  need: SlotItemStorageNeed,
  todayIso: string,
): Promise<HeldItem[]> {
  if (need.portions === 0) return [];
  const conditions = [
    eq(stockItems.householdId, CURRENT_HOUSEHOLD_ID),
    eq(stockItems.recipeId, need.targetRecipeId),
    inArray(stockItems.location, [...need.locations]),
  ];
  if (need.stockItemIds) {
    if (need.stockItemIds.length === 0) return [];
    conditions.push(inArray(stockItems.id, [...need.stockItemIds]));
  }
  const rows = await tx
    .select({
      id: stockItems.id,
      location: stockItems.location,
      quantity: stockItems.quantity,
      addedOn: stockItems.addedOn,
      useBy: stockItems.useBy,
      reserved: sql<string>`coalesce(sum(${stockReservations.amount}), 0)::numeric(10,3)::text`,
    })
    .from(stockItems)
    .leftJoin(
      stockReservations,
      and(
        eq(stockReservations.stockItemId, stockItems.id),
        eq(stockReservations.householdId, CURRENT_HOUSEHOLD_ID),
      ),
    )
    .where(and(...conditions))
    .groupBy(stockItems.id);

  return rows
    .map((row) => ({
      stockItemId: row.id,
      location: row.location,
      quantityMilli: parseMilliFromFixed3(row.quantity),
      reservedByOthersMilli: parseMilliFromFixed3(row.reserved),
      reservedByLineMilli: 0n,
      addedOn: formatCivilDate(row.addedOn),
      useBy: row.useBy ? formatCivilDate(row.useBy) : null,
    }))
    .filter(
      (item) =>
        need.stockItemIds !== undefined ||
        item.useBy === null ||
        item.useBy >= todayIso,
    );
}

// After a drag: each moved dish's Reservations follow it to its new day.
export async function followSlotItemsToTheirDay(
  tx: Tx,
  slotItemIds: readonly number[],
): Promise<void> {
  if (slotItemIds.length === 0) return;
  const ids = [...slotItemIds];
  await tx
    .select({ id: stockItems.id })
    .from(stockItems)
    .where(
      and(
        eq(stockItems.householdId, CURRENT_HOUSEHOLD_ID),
        inArray(
          stockItems.id,
          tx
            .select({ id: stockReservations.stockItemId })
            .from(stockReservations)
            .where(
              and(
                eq(stockReservations.householdId, CURRENT_HOUSEHOLD_ID),
                inArray(stockReservations.slotItemId, ids),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(stockItems.id))
    .for('update');
  await tx
    .update(stockReservations)
    .set({
      neededOn: sql`(select ${mealPlanSlots.date} from ${mealPlanSlots} inner join ${mealPlanSlotItems} on ${mealPlanSlotItems.slotId} = ${mealPlanSlots.id} where ${mealPlanSlotItems.id} = ${stockReservations.slotItemId})`,
    })
    .where(
      and(
        eq(stockReservations.householdId, CURRENT_HOUSEHOLD_ID),
        isNotNull(stockReservations.slotItemId),
        inArray(stockReservations.slotItemId, ids),
      ),
    );
}
