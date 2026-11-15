import type { StorageLocation } from '../../../shared/src/index.ts';

// Pure rules for shopping against storage (DEC-118). The aggregation stays a
// pure sum per ingredient (DEC-18); these work on its totals afterwards. All
// amounts are integer thousandths, as in `shopping-aggregation.ts`.

export interface HeldItem {
  stockItemId: number;
  location: StorageLocation;
  quantityMilli: bigint;
  // Every Reservation on the item except this line's own.
  reservedByOthersMilli: bigint;
  reservedByLineMilli: bigint;
  addedOn: string;
  useBy: string | null;
}

export interface Draw {
  stockItemId: number;
  amountMilli: bigint;
}

// What this line could reserve from the item, its own share included.
export function availableToLine(item: HeldItem): bigint {
  const available = item.quantityMilli - item.reservedByOthersMilli;
  return available > 0n ? available : 0n;
}

// The default order a line draws in: Fridge items by soonest Use-by, then the
// oldest Freezer and Pantry items, taken together. Ties fall back to the
// date added, then the id, so the order is stable.
export function compareDrawOrder(a: HeldItem, b: HeldItem): number {
  const aFridge = a.location === 'fridge';
  const bFridge = b.location === 'fridge';
  if (aFridge !== bFridge) return aFridge ? -1 : 1;
  if (aFridge && a.useBy !== b.useBy) {
    if (a.useBy === null) return 1;
    if (b.useBy === null) return -1;
    return a.useBy < b.useBy ? -1 : 1;
  }
  if (a.addedOn !== b.addedOn) return a.addedOn < b.addedOn ? -1 : 1;
  return a.stockItemId - b.stockItemId;
}

export function sortInDrawOrder(items: HeldItem[]): HeldItem[] {
  return [...items].sort(compareDrawOrder);
}

// Takes up to `targetMilli` from the items in draw order. Returns fewer if
// less is available.
export function planDraws(items: HeldItem[], targetMilli: bigint): Draw[] {
  const draws: Draw[] = [];
  let remaining = targetMilli;
  for (const item of sortInDrawOrder(items)) {
    if (remaining <= 0n) break;
    const available = availableToLine(item);
    if (available <= 0n) continue;
    const amountMilli = available < remaining ? available : remaining;
    draws.push({ stockItemId: item.stockItemId, amountMilli });
    remaining -= amountMilli;
  }
  return draws;
}

export interface LineReservation {
  id: number;
  stockItemId: number;
  amountMilli: bigint;
}

export interface ReleasePlan {
  deleteIds: number[];
  // The amount each lowered Reservation should now hold.
  lower: { id: number; amountMilli: bigint }[];
}

// Releases `excessMilli` of a line's Reservations, the last-drawn item first.
// `order` is the line's items in draw order; a Reservation on an item missing
// from it is released first.
export function planRelease(
  reservations: LineReservation[],
  order: HeldItem[],
  excessMilli: bigint,
): ReleasePlan {
  const rank = new Map(
    sortInDrawOrder(order).map((item, index) => [item.stockItemId, index]),
  );
  const lastDrawnFirst = [...reservations].sort((a, b) => {
    const aRank = rank.get(a.stockItemId) ?? Number.MAX_SAFE_INTEGER;
    const bRank = rank.get(b.stockItemId) ?? Number.MAX_SAFE_INTEGER;
    if (aRank !== bRank) return bRank - aRank;
    return b.id - a.id;
  });

  const plan: ReleasePlan = { deleteIds: [], lower: [] };
  let remaining = excessMilli;
  for (const reservation of lastDrawnFirst) {
    if (remaining <= 0n) break;
    if (reservation.amountMilli <= remaining) {
      plan.deleteIds.push(reservation.id);
      remaining -= reservation.amountMilli;
    } else {
      plan.lower.push({
        id: reservation.id,
        amountMilli: reservation.amountMilli - remaining,
      });
      remaining = 0n;
    }
  }
  return plan;
}
