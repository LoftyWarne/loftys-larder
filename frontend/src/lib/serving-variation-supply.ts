import {
  OCCASION_ORDER,
  type PlanSlot,
  type PlanSlotItem,
} from '@loftys-larder/shared';

// Cooked base is a pool that meals draw down (DEC-88/DEC-89; 1:1 — one eaten
// serving consumes one base serving). Walking the plan in cook-before-eat
// order (date, then occasion: Lunch < Dinner), each slot first ADDS its
// `cook_ahead` items (base produced in bulk) then SUBTRACTS its `eat` items —
// an eat item draws on `item.isBase ? item.recipeId : item.baseRecipeId`
// (eating a variation of a base, or the base itself). A slot that draws a base
// below zero is short by the unsupplied servings. Computed over the cached
// plan, no round-trip.

export interface BaseBalances {
  // Slots that ate more base than was cooked up to that point, mapped to how
  // many base servings short they were (a positive number).
  shortfallBySlot: Map<number, number>;
  // End-of-plan remaining cooked base per base recipe id (may be negative).
  remainingByBase: Map<number, number>;
}

export function deriveBaseBalances(slots: readonly PlanSlot[]): BaseBalances {
  const ordered = [...slots].sort(compareSlotOrder);
  const balance = new Map<number, number>();
  const shortfallBySlot = new Map<number, number>();

  for (const slot of ordered) {
    // 1. Produce — cook_ahead items add to the pool first, so a slot that cooks
    //    and eats the same base self-supplies.
    for (const item of slot.items) {
      if (item.kind !== 'cook_ahead') continue;
      balance.set(
        item.recipeId,
        (balance.get(item.recipeId) ?? 0) + item.servings,
      );
    }
    // 2. Consume — eat items draw their base down.
    let slotShort = 0;
    for (const item of slot.items) {
      if (item.kind !== 'eat') continue;
      const baseId = itemConsumedBase(item);
      if (baseId === null) continue;
      const before = balance.get(baseId) ?? 0;
      balance.set(baseId, before - item.servings);
      slotShort += Math.max(0, item.servings - Math.max(before, 0));
    }
    if (slotShort > 0) shortfallBySlot.set(slot.id, slotShort);
  }

  return { shortfallBySlot, remainingByBase: balance };
}

// The base an eat item draws on: the base itself when eating a base, or its
// base when eating a serving variation; null for a standalone dish.
export function itemConsumedBase(item: PlanSlotItem): number | null {
  return item.isBase ? item.recipeId : item.baseRecipeId;
}

function compareSlotOrder(a: PlanSlot, b: PlanSlot): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  const aOrder = OCCASION_ORDER[a.occasionName] ?? 0;
  const bOrder = OCCASION_ORDER[b.occasionName] ?? 0;
  if (aOrder !== bOrder) return aOrder - bOrder;
  return a.id - b.id;
}
