import { OCCASION_ORDER, type PlanSlot } from '@loftys-larder/shared';

// Cooked portions are a per-recipe pool that meals draw down (DEC-88/DEC-91;
// 1:1). Walking the plan in cook-before-eat order (date, then occasion: Lunch <
// Dinner), each slot first PRODUCES — every item adds its `prepared` portions to
// its own recipe's pool, so a slot that cooks and eats the same dish
// self-supplies — then CONSUMES: a serving variation draws its base pool by what
// it prepared (making N variation portions needs N base portions), and every
// item draws its own pool by what it ate. A draw that takes a pool below zero is
// a shortfall for that slot. Computed over the cached plan, no round-trip.

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

export function deriveBaseBalances(slots: readonly PlanSlot[]): BaseBalances {
  const ordered = [...slots].sort(compareSlotOrder);
  const balance = new Map<number, number>();
  const shortfallBySlot = new Map<number, number>();
  const shortfallByItem = new Map<number, number>();

  for (const slot of ordered) {
    // 1. Produce — a slot's prepared portions land in each recipe's pool first,
    //    so cooking and eating the same dish here self-supplies.
    for (const item of slot.items) {
      if (item.prepared <= 0) continue;
      balance.set(
        item.recipeId,
        (balance.get(item.recipeId) ?? 0) + item.prepared,
      );
    }
    // 2. Consume — a variation draws its base pool by what it prepared; every
    //    item draws its own pool by what it ate. Attribute any deficit to the
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
      if (item.eaten > 0) draw(item.recipeId, item.eaten);
      if (itemShort > 0) {
        shortfallByItem.set(item.id, itemShort);
        slotShort += itemShort;
      }
    }
    if (slotShort > 0) shortfallBySlot.set(slot.id, slotShort);
  }

  return { shortfallBySlot, shortfallByItem, remainingByBase: balance };
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

function compareSlotOrder(a: PlanSlot, b: PlanSlot): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  const aOrder = OCCASION_ORDER[a.occasionName] ?? 0;
  const bOrder = OCCASION_ORDER[b.occasionName] ?? 0;
  if (aOrder !== bOrder) return aOrder - bOrder;
  return a.id - b.id;
}
