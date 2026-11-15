import {
  compareSlotOrder,
  type PlanSlot,
  type PlanSlotItem,
} from '@loftys-larder/shared';

import { todayInLondon } from '@/lib/date-utils.ts';

// Cooked portions are a per-recipe pool that meals draw down (DEC-88/DEC-91;
// 1:1). Walking the plan in cook-before-eat order (date, then occasion: Lunch <
// Dinner), each slot first PRODUCES — every item adds its `prepared` portions to
// its own recipe's pool, so a slot that cooks and eats the same dish
// self-supplies — then CONSUMES: a serving variation draws its base pool by what
// it prepared (making N variation portions needs N base portions), and every
// item draws its own pool by what it ate and what it sent to storage (FEAT-79).
// Portions taken from storage (FEAT-81) join the pool at their slot, before it
// consumes: a Leftovers from Storage dish's own pool, or a Variation's base
// pool. Until the day has passed only what's actually reserved counts, so not
// enough held shows as a shortfall; after, the Reservations have settled and
// the slot's record counts. A draw that takes a pool below zero is a shortfall
// for that slot. Computed over the cached plan, no round-trip.

export interface BaseBalances {
  // Slots that ate/used more of a recipe than was cooked up to that point,
  // mapped to how many portions short they were (a positive number).
  shortfallBySlot: Map<number, number>;
  // The same shortfall attributed to the specific dish (slot-item id) whose
  // draw ran the pool negative — drives the per-dish nudge on the slot card.
  shortfallByItem: Map<number, number>;
  // End-of-plan remaining cooked portions per recipe id (may be negative).
  remainingByBase: Map<number, number>;
}

export function deriveBaseBalances(
  slots: readonly PlanSlot[],
  today: string = todayInLondon(),
): BaseBalances {
  const ordered = [...slots].sort(
    (a, b) => compareSlotOrder(a, b) || a.id - b.id,
  );
  const balance = new Map<number, number>();
  const shortfallBySlot = new Map<number, number>();
  const shortfallByItem = new Map<number, number>();

  for (const slot of ordered) {
    // 1. Produce — a slot's prepared portions land in each recipe's pool first,
    //    so cooking and eating the same dish here self-supplies.
    for (const item of slot.items) {
      if (item.prepared > 0) {
        balance.set(
          item.recipeId,
          (balance.get(item.recipeId) ?? 0) + item.prepared,
        );
      }
      const supply = storageSupply(slot, item, today);
      if (supply > 0) {
        const target = storageTarget(item);
        balance.set(target, (balance.get(target) ?? 0) + supply);
      }
    }
    // 2. Consume — a variation draws its base pool by what it prepared; every
    //    item draws its own pool by what it ate or stored. Attribute any deficit to the
    //    dish whose draw went negative.
    let slotShort = 0;
    for (const item of slot.items) {
      let itemShort = 0;
      const draw = (key: number, qty: number): void => {
        const before = balance.get(key) ?? 0;
        balance.set(key, before - qty);
        itemShort += Math.max(0, qty - Math.max(before, 0));
      };
      if (item.baseRecipeId !== null && item.prepared > 0) {
        draw(item.baseRecipeId, item.prepared);
      }
      const used = item.eaten + item.frozen + item.chilled;
      if (used > 0) draw(item.recipeId, used);
      if (itemShort > 0) {
        shortfallByItem.set(item.id, itemShort);
        slotShort += itemShort;
      }
    }
    if (slotShort > 0) shortfallBySlot.set(slot.id, slotShort);
  }

  return { shortfallBySlot, shortfallByItem, remainingByBase: balance };
}

// The recipe a dish's storage portions are of: a cooked Variation's base, or
// the dish itself (Leftovers from Storage), as the server reserves them.
export function storageTarget(
  item: Pick<PlanSlotItem, 'recipeId' | 'prepared' | 'baseRecipeId'>,
): number {
  return item.prepared > 0 && item.baseRecipeId !== null
    ? item.baseRecipeId
    : item.recipeId;
}

// The storage portions that count for a dish at its slot.
export function storageSupply(
  slot: Pick<PlanSlot, 'date'>,
  item: Pick<PlanSlotItem, 'fromStorage' | 'reserved'>,
  today: string,
): number {
  if (item.fromStorage <= 0) return 0;
  if (slot.date < today) return item.fromStorage;
  return Math.min(item.fromStorage, item.reserved);
}

// The base a dish draws on: the base itself for a base recipe, or its base for a
// serving variation; null for a standalone dish. Typed on the minimal shape so
// both `PlanSlotItem` and the slot editor's working item can reuse it (used by
// the suggested-base shortcut).
export function itemConsumedBase(item: {
  isBase: boolean;
  recipeId: number;
  baseRecipeId: number | null;
}): number | null {
  return item.isBase ? item.recipeId : item.baseRecipeId;
}
