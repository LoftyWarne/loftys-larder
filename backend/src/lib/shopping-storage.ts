import { TRPCError } from '@trpc/server';
import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm';

import type { LineReservationChoice } from '../../../shared/src/index.ts';
import { CURRENT_HOUSEHOLD_ID } from '../config.ts';
import { stockItems, stockReservations } from '../db/schema/storage.ts';
import type { Tx } from '../db/withTransaction.ts';
import { formatCivilDate, parseCivilDate } from './date-utils.ts';
import {
  formatFixed3FromMilli,
  parseMilliFromFixed3,
} from './shopping-aggregation.ts';
import {
  availableToLine,
  planDraws,
  planRelease,
  type Draw,
  type HeldItem,
  type LineReservation,
} from './shopping-holdings.ts';

// A shopping line's Reservations (DEC-118). A line is (plan, ingredient), so
// its Reservations are the plan's rows with that `ingredient_id`.

export interface LineNeed {
  neededMilli: bigint;
  // The date of the first slot in the plan that uses the ingredient.
  neededOn: string;
}

async function lockStockItems(
  tx: Tx,
  where: ReturnType<typeof and>,
): Promise<void> {
  await tx
    .select({ id: stockItems.id })
    .from(stockItems)
    .where(where)
    .orderBy(asc(stockItems.id))
    .for('update');
}

function lineReservationsWhere(planId: number) {
  return and(
    eq(stockReservations.planId, planId),
    eq(stockReservations.householdId, CURRENT_HOUSEHOLD_ID),
    isNotNull(stockReservations.ingredientId),
  );
}

// Brings the plan's line Reservations in line with what the plan now needs,
// on each read of its list. A line the plan no longer needs (or whose
// ingredient became a Staple) is released. A line reserving more than the
// plan needs releases the excess, the last-drawn item first. `needed_on`
// follows the first slot that uses the ingredient. A recipe edit that only
// lowers the need below what's reserved is the one case that changes the
// amount the cook chose.
//
// Writes set absolute values, so two reads at once reach the same result.
export async function reconcileLineReservations(
  tx: Tx,
  planId: number,
  needs: Map<number, LineNeed>,
): Promise<void> {
  const rows = await tx
    .select({
      id: stockReservations.id,
      ingredientId: stockReservations.ingredientId,
      stockItemId: stockReservations.stockItemId,
      amount: stockReservations.amount,
      neededOn: stockReservations.neededOn,
      location: stockItems.location,
      addedOn: stockItems.addedOn,
      useBy: stockItems.useBy,
    })
    .from(stockReservations)
    .innerJoin(stockItems, eq(stockItems.id, stockReservations.stockItemId))
    .where(lineReservationsWhere(planId));
  if (rows.length === 0) return;

  const byIngredient = new Map<number, typeof rows>();
  for (const row of rows) {
    if (row.ingredientId === null) continue;
    const group = byIngredient.get(row.ingredientId) ?? [];
    group.push(row);
    byIngredient.set(row.ingredientId, group);
  }

  const deleteIds: number[] = [];
  const lower: { id: number; amountMilli: bigint }[] = [];
  const moveNeededOn = new Map<string, number[]>();

  for (const [ingredientId, group] of byIngredient) {
    const need = needs.get(ingredientId);
    if (!need) {
      deleteIds.push(...group.map((row) => row.id));
      continue;
    }

    for (const row of group) {
      if (formatCivilDate(row.neededOn) !== need.neededOn) {
        const ids = moveNeededOn.get(need.neededOn) ?? [];
        ids.push(row.id);
        moveNeededOn.set(need.neededOn, ids);
      }
    }

    const reservations: LineReservation[] = group.map((row) => ({
      id: row.id,
      stockItemId: row.stockItemId,
      amountMilli: parseMilliFromFixed3(row.amount),
    }));
    const reservedMilli = reservations.reduce(
      (sum, reservation) => sum + reservation.amountMilli,
      0n,
    );
    if (reservedMilli <= need.neededMilli) continue;

    const order: HeldItem[] = group.map((row) => ({
      stockItemId: row.stockItemId,
      location: row.location,
      quantityMilli: 0n,
      reservedByOthersMilli: 0n,
      reservedByLineMilli: 0n,
      addedOn: formatCivilDate(row.addedOn),
      useBy: row.useBy ? formatCivilDate(row.useBy) : null,
    }));
    const release = planRelease(
      reservations,
      order,
      reservedMilli - need.neededMilli,
    );
    deleteIds.push(...release.deleteIds);
    lower.push(...release.lower);
  }

  const touched = new Set<number>([
    ...deleteIds,
    ...lower.map((entry) => entry.id),
    ...[...moveNeededOn.values()].flat(),
  ]);
  if (touched.size === 0) return;
  // Stock items before their Reservations, as every storage write does.
  await lockStockItems(
    tx,
    and(
      eq(stockItems.householdId, CURRENT_HOUSEHOLD_ID),
      inArray(
        stockItems.id,
        rows.filter((row) => touched.has(row.id)).map((row) => row.stockItemId),
      ),
    ),
  );

  if (deleteIds.length > 0) {
    await tx
      .delete(stockReservations)
      .where(
        and(
          eq(stockReservations.householdId, CURRENT_HOUSEHOLD_ID),
          inArray(stockReservations.id, deleteIds),
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
  for (const [neededOn, ids] of moveNeededOn) {
    const live = ids.filter((id) => !deleteIds.includes(id));
    if (live.length === 0) continue;
    await tx
      .update(stockReservations)
      .set({ neededOn: parseCivilDate(neededOn) })
      .where(
        and(
          eq(stockReservations.householdId, CURRENT_HOUSEHOLD_ID),
          inArray(stockReservations.id, live),
        ),
      );
  }
}

// The Stock items held for each ingredient, as the plan's lines see them.
// Recipe portions never net against an ingredient line.
export async function loadLineHoldings(
  tx: Tx,
  planId: number,
  ingredientIds: number[],
): Promise<Map<number, HeldItem[]>> {
  const holdings = new Map<number, HeldItem[]>();
  if (ingredientIds.length === 0) return holdings;

  const itemWhere = and(
    eq(stockItems.householdId, CURRENT_HOUSEHOLD_ID),
    inArray(stockItems.ingredientId, ingredientIds),
  );

  const rows = await tx
    .select({
      id: stockItems.id,
      ingredientId: stockItems.ingredientId,
      location: stockItems.location,
      quantity: stockItems.quantity,
      addedOn: stockItems.addedOn,
      useBy: stockItems.useBy,
      reservedTotal: sql<string>`coalesce(sum(${stockReservations.amount}), 0)::numeric(10,3)::text`,
      reservedByLine: sql<string>`coalesce(sum(${stockReservations.amount}) filter (where ${stockReservations.planId} = ${planId} and ${stockReservations.ingredientId} = ${stockItems.ingredientId}), 0)::numeric(10,3)::text`,
    })
    .from(stockItems)
    .leftJoin(
      stockReservations,
      and(
        eq(stockReservations.stockItemId, stockItems.id),
        eq(stockReservations.householdId, CURRENT_HOUSEHOLD_ID),
      ),
    )
    .where(itemWhere)
    .groupBy(stockItems.id);

  for (const row of rows) {
    if (row.ingredientId === null) continue;
    const byLine = parseMilliFromFixed3(row.reservedByLine);
    const item: HeldItem = {
      stockItemId: row.id,
      location: row.location,
      quantityMilli: parseMilliFromFixed3(row.quantity),
      reservedByOthersMilli: parseMilliFromFixed3(row.reservedTotal) - byLine,
      reservedByLineMilli: byLine,
      addedOn: formatCivilDate(row.addedOn),
      useBy: row.useBy ? formatCivilDate(row.useBy) : null,
    };
    const group = holdings.get(row.ingredientId) ?? [];
    group.push(item);
    holdings.set(row.ingredientId, group);
  }
  return holdings;
}

function tooMuch(availableMilli: bigint, neededMilli: bigint): TRPCError {
  return new TRPCError({
    code: 'BAD_REQUEST',
    message: 'That’s more than is held or needed',
    cause: {
      code: 'SHOPPING_RESERVE_TOO_MUCH',
      available: formatFixed3FromMilli(availableMilli),
      needed: formatFixed3FromMilli(neededMilli),
    },
  });
}

// Replaces one line's Reservations with the cook's choice. The caller has
// settled Reservations and checked the plan needs the ingredient. Returns the
// amount now reserved.
export async function replaceLineReservations(
  tx: Tx,
  planId: number,
  ingredientId: number,
  need: LineNeed,
  choice: LineReservationChoice,
): Promise<bigint> {
  // Stock items before their Reservations, the order `storage.update`,
  // `storage.delete` and marking a Staple take, so none can deadlock with
  // this. Every path that adds a Reservation locks its items first, so
  // reading Reservations after the lock sees them all.
  await lockStockItems(
    tx,
    and(
      eq(stockItems.householdId, CURRENT_HOUSEHOLD_ID),
      eq(stockItems.ingredientId, ingredientId),
    ),
  );
  await tx
    .delete(stockReservations)
    .where(
      and(
        lineReservationsWhere(planId),
        eq(stockReservations.ingredientId, ingredientId),
      ),
    );

  if (choice.kind === 'none') return 0n;

  const held =
    (await loadLineHoldings(tx, planId, [ingredientId])).get(ingredientId) ??
    [];
  const totalAvailable = held.reduce(
    (sum, item) => sum + availableToLine(item),
    0n,
  );

  let draws: Draw[];
  if (choice.kind === 'all') {
    const target =
      need.neededMilli < totalAvailable ? need.neededMilli : totalAvailable;
    draws = planDraws(held, target);
  } else if (choice.kind === 'amount') {
    const amount = parseMilliFromFixed3(choice.amount);
    if (amount > totalAvailable || amount > need.neededMilli) {
      throw tooMuch(totalAvailable, need.neededMilli);
    }
    draws = planDraws(held, amount);
  } else {
    const byId = new Map(held.map((item) => [item.stockItemId, item]));
    const combined = new Map<number, bigint>();
    for (const draw of choice.draws) {
      if (!byId.has(draw.stockItemId)) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Stock item not found',
          cause: { code: 'STOCK_ITEM_NOT_FOUND' },
        });
      }
      combined.set(
        draw.stockItemId,
        (combined.get(draw.stockItemId) ?? 0n) +
          parseMilliFromFixed3(draw.amount),
      );
    }
    let total = 0n;
    draws = [];
    for (const [stockItemId, amountMilli] of combined) {
      const item = byId.get(stockItemId);
      if (!item || amountMilli > availableToLine(item)) {
        throw tooMuch(totalAvailable, need.neededMilli);
      }
      total += amountMilli;
      draws.push({ stockItemId, amountMilli });
    }
    if (total > need.neededMilli) {
      throw tooMuch(totalAvailable, need.neededMilli);
    }
  }

  const neededOn = parseCivilDate(need.neededOn);
  const values = draws
    .filter((draw) => draw.amountMilli > 0n)
    .map((draw) => ({
      householdId: CURRENT_HOUSEHOLD_ID,
      stockItemId: draw.stockItemId,
      planId,
      ingredientId,
      amount: formatFixed3FromMilli(draw.amountMilli),
      neededOn,
    }));
  if (values.length > 0) {
    await tx.insert(stockReservations).values(values);
  }
  return values.reduce(
    (sum, value) => sum + parseMilliFromFixed3(value.amount),
    0n,
  );
}

// What one line has reserved, for the tick's left-to-buy figure.
export async function lineReservedMilli(
  tx: Tx,
  planId: number,
  ingredientId: number,
): Promise<bigint> {
  const [row] = await tx
    .select({
      reserved: sql<string>`coalesce(sum(${stockReservations.amount}), 0)::numeric(10,3)::text`,
    })
    .from(stockReservations)
    .where(
      and(
        lineReservationsWhere(planId),
        eq(stockReservations.ingredientId, ingredientId),
      ),
    );
  return row ? parseMilliFromFixed3(row.reserved) : 0n;
}
