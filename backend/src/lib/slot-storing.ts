import { and, desc, eq, inArray, sql } from 'drizzle-orm';

import {
  defaultUseBy,
  type PlanStoreLocation,
} from '../../../shared/src/index.ts';
import { CURRENT_HOUSEHOLD_ID } from '../config.ts';
import { stockItems, stockReservations } from '../db/schema/storage.ts';
import type { Tx } from '../db/withTransaction.ts';

import { formatCivilDate, parseCivilDate } from './date-utils.ts';

// Storing from the plan (DEC-118, FEAT-79): a slot item's `frozen` / `chilled`
// count moves, and Stock items follow. Raising makes one Stock item linked back
// by `source_slot_item_id`; lowering takes back linked portions in that
// location, newest first, but only what's still held and not reserved. The
// caller writes the count it gets back, inside the same transaction, and must
// have settled Reservations first (cross-cutting #23).

export interface StoredChange {
  slotItemId: number;
  recipeId: number;
  location: PlanStoreLocation;
  from: number;
  to: number;
}

// Returns the count actually reached: `to` when raising, or the lowest count
// the held, unreserved portions allow when lowering.
export async function changeStored(
  tx: Tx,
  change: StoredChange,
  today: Date,
): Promise<number> {
  if (change.to > change.from) {
    await addStock(tx, change, change.to - change.from, today);
    return change.to;
  }
  if (change.to < change.from) {
    const taken = await takeBackStock(tx, change, change.from - change.to);
    return change.from - taken;
  }
  return change.from;
}

async function addStock(
  tx: Tx,
  change: StoredChange,
  portions: number,
  today: Date,
): Promise<void> {
  const useBy =
    change.location === 'fridge'
      ? defaultUseBy(formatCivilDate(today), { kind: 'recipe' })
      : null;
  await tx.insert(stockItems).values({
    householdId: CURRENT_HOUSEHOLD_ID,
    location: change.location,
    recipeId: change.recipeId,
    quantity: String(portions),
    addedOn: today,
    useBy: useBy === null ? null : parseCivilDate(useBy),
    sourceSlotItemId: change.slotItemId,
  });
}

// Milli-portions, so amounts compare and subtract exactly.
function toMilli(quantity: string): number {
  return Math.round(Number(quantity) * 1000);
}

// Takes back up to `portions` whole portions and returns how many it took.
async function takeBackStock(
  tx: Tx,
  change: StoredChange,
  portions: number,
): Promise<number> {
  const items = await tx
    .select({ id: stockItems.id, quantity: stockItems.quantity })
    .from(stockItems)
    .where(
      and(
        eq(stockItems.householdId, CURRENT_HOUSEHOLD_ID),
        eq(stockItems.sourceSlotItemId, change.slotItemId),
        eq(stockItems.location, change.location),
      ),
    )
    .orderBy(desc(stockItems.addedOn), desc(stockItems.id))
    .for('update', { of: stockItems });
  if (items.length === 0) return 0;

  const reserved = await tx
    .select({
      stockItemId: stockReservations.stockItemId,
      amount: sql<string>`sum(${stockReservations.amount})`,
    })
    .from(stockReservations)
    .where(
      and(
        eq(stockReservations.householdId, CURRENT_HOUSEHOLD_ID),
        inArray(
          stockReservations.stockItemId,
          items.map((item) => item.id),
        ),
      ),
    )
    .groupBy(stockReservations.stockItemId);
  const reservedById = new Map(
    reserved.map((row) => [row.stockItemId, toMilli(row.amount)]),
  );

  const free = items.map((item) => {
    const held = toMilli(item.quantity);
    return { id: item.id, held, free: held - (reservedById.get(item.id) ?? 0) };
  });
  const totalFree = free.reduce((sum, item) => sum + Math.max(item.free, 0), 0);
  // The plan's counts are whole portions, so only whole portions come back.
  const taking = Math.min(portions, Math.floor(totalFree / 1000));

  let leftMilli = taking * 1000;
  for (const item of free) {
    if (leftMilli === 0) break;
    const take = Math.min(Math.max(item.free, 0), leftMilli);
    if (take === 0) continue;
    leftMilli -= take;
    const remaining = item.held - take;
    if (remaining === 0) {
      await tx
        .delete(stockItems)
        .where(
          and(
            eq(stockItems.id, item.id),
            eq(stockItems.householdId, CURRENT_HOUSEHOLD_ID),
          ),
        );
    } else {
      await tx
        .update(stockItems)
        .set({ quantity: (remaining / 1000).toFixed(3) })
        .where(
          and(
            eq(stockItems.id, item.id),
            eq(stockItems.householdId, CURRENT_HOUSEHOLD_ID),
          ),
        );
    }
  }
  return taking;
}
