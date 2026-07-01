import type { PlanSlot, PlanSlotItem } from '@loftys-larder/shared';
import { describe, expect, it } from 'vitest';

import { deriveBaseBalances } from './serving-variation-supply.ts';

let nextId = 1;

interface ItemSpec {
  recipeId: number;
  prepared: number;
  eaten: number;
  isBase?: boolean;
  baseRecipeId?: number | null;
}

interface SlotSpec {
  date: string;
  occasion?: 'Lunch' | 'Dinner';
  items?: ItemSpec[];
}

function item(spec: ItemSpec): PlanSlotItem {
  const id = nextId++;
  return {
    id,
    recipeId: spec.recipeId,
    recipeName: 'R',
    recipeImageUrl: null,
    isBase: spec.isBase ?? false,
    baseRecipeId: spec.baseRecipeId ?? null,
    isDeleted: false,
    prepared: spec.prepared,
    eaten: spec.eaten,
    sortOrder: 0,
  };
}

function slot(spec: SlotSpec): PlanSlot {
  const id = nextId++;
  const occasionName = spec.occasion ?? 'Dinner';
  const items = spec.items ?? [];
  return {
    id,
    planId: 1,
    date: spec.date,
    occasionId: occasionName === 'Lunch' ? 1 : 2,
    occasionName,
    slotType: items.some((i) => i.eaten > 0) ? 'recipe' : 'empty',
    leftoversSource: null,
    chefUserId: null,
    comment: null,
    items: items.map(item),
    dinerUserIds: [],
    guestCount: 0,
  };
}

// Cook a base batch (prepared only, none eaten here).
function cook(baseId: number, servings: number): ItemSpec {
  return { recipeId: baseId, prepared: servings, eaten: 0, isBase: true };
}
// Eat a serving variation of base B, cooked fresh from the base pool: making N
// variation portions draws N base portions.
function eatVariation(baseId: number, servings: number): ItemSpec {
  return {
    recipeId: 900 + baseId,
    prepared: servings,
    eaten: servings,
    baseRecipeId: baseId,
  };
}
// Eat the base B itself from a batch cooked elsewhere (pure consume).
function eatBase(baseId: number, servings: number): ItemSpec {
  return { recipeId: baseId, prepared: 0, eaten: servings, isBase: true };
}
// A standalone meal cooked and (partly) eaten in one slot.
function cookEatStandalone(
  recipeId: number,
  prepared: number,
  eaten: number,
): ItemSpec {
  return { recipeId, prepared, eaten };
}
// Eat leftovers of a recipe from a batch cooked elsewhere (pure consume).
function eatLeftover(recipeId: number, servings: number): ItemSpec {
  return { recipeId, prepared: 0, eaten: servings };
}

describe('deriveBaseBalances', () => {
  it('no shortfall when the cook covers later consumption; remaining is the leftover', () => {
    const cookSlot = slot({ date: '2026-06-15', items: [cook(22, 12)] });
    const eatSlot = slot({ date: '2026-06-16', items: [eatVariation(22, 8)] });
    const { shortfallBySlot, remainingByBase } = deriveBaseBalances([
      cookSlot,
      eatSlot,
    ]);
    expect(shortfallBySlot.size).toBe(0);
    expect(remainingByBase.get(22)).toBe(4);
  });

  it('flags a shortfall when consumption outruns the cook', () => {
    const cookSlot = slot({ date: '2026-06-15', items: [cook(22, 8)] });
    const eatSlot = slot({ date: '2026-06-16', items: [eatVariation(22, 12)] });
    const { shortfallBySlot, remainingByBase } = deriveBaseBalances([
      cookSlot,
      eatSlot,
    ]);
    expect(shortfallBySlot.get(eatSlot.id)).toBe(4);
    expect(remainingByBase.get(22)).toBe(-4);
  });

  it('attributes the shortfall to the specific dish that ran short', () => {
    const cookSlot = slot({ date: '2026-06-15', items: [cook(22, 8)] });
    const eatSlot = slot({ date: '2026-06-16', items: [eatVariation(22, 12)] });
    const { shortfallByItem } = deriveBaseBalances([cookSlot, eatSlot]);
    const shortItemId = eatSlot.items[0]?.id ?? 0;
    expect(shortfallByItem.get(shortItemId)).toBe(4);
    expect(shortfallByItem.size).toBe(1);
  });

  it('self-supplies when one slot cooks and eats the same base', () => {
    const s = slot({
      date: '2026-06-15',
      items: [cook(22, 4), eatBase(22, 4)],
    });
    const { shortfallBySlot, remainingByBase } = deriveBaseBalances([s]);
    expect(shortfallBySlot.size).toBe(0);
    expect(remainingByBase.get(22)).toBe(0);
  });

  it('respects cook-before-eat ordering (eating before the cook is a shortfall)', () => {
    const eatSlot = slot({ date: '2026-06-15', items: [eatVariation(22, 4)] });
    const cookSlot = slot({ date: '2026-06-16', items: [cook(22, 12)] });
    const { shortfallBySlot } = deriveBaseBalances([cookSlot, eatSlot]);
    expect(shortfallBySlot.get(eatSlot.id)).toBe(4);
  });

  it('counts the base eaten directly plus variations against the same pool', () => {
    const cookSlot = slot({ date: '2026-06-15', items: [cook(22, 12)] });
    const eatBaseSlot = slot({ date: '2026-06-15', items: [eatBase(22, 4)] });
    const eatVarSlot = slot({
      date: '2026-06-16',
      items: [eatVariation(22, 8)],
    });
    const { shortfallBySlot, remainingByBase } = deriveBaseBalances([
      cookSlot,
      eatBaseSlot,
      eatVarSlot,
    ]);
    expect(shortfallBySlot.size).toBe(0);
    expect(remainingByBase.get(22)).toBe(0);
  });

  it('orders same-day slots by occasion (Lunch before Dinner)', () => {
    const lunchCook = slot({
      date: '2026-06-15',
      occasion: 'Lunch',
      items: [cook(22, 6)],
    });
    const dinnerEat = slot({
      date: '2026-06-15',
      occasion: 'Dinner',
      items: [eatVariation(22, 6)],
    });
    const { shortfallBySlot } = deriveBaseBalances([dinnerEat, lunchCook]);
    expect(shortfallBySlot.size).toBe(0);
  });

  it('over-cooks a standalone meal and eats the surplus as leftovers', () => {
    const cookSlot = slot({
      date: '2026-06-15',
      items: [cookEatStandalone(40, 8, 4)],
    });
    const leftoverSlot = slot({
      date: '2026-06-16',
      items: [eatLeftover(40, 4)],
    });
    const { shortfallBySlot, remainingByBase } = deriveBaseBalances([
      cookSlot,
      leftoverSlot,
    ]);
    expect(shortfallBySlot.size).toBe(0);
    expect(remainingByBase.get(40)).toBe(0);
  });

  it('flags a shortfall when standalone leftovers outrun the surplus', () => {
    const cookSlot = slot({
      date: '2026-06-15',
      items: [cookEatStandalone(40, 8, 4)],
    });
    const leftoverSlot = slot({
      date: '2026-06-16',
      items: [eatLeftover(40, 6)],
    });
    const { shortfallBySlot, remainingByBase } = deriveBaseBalances([
      cookSlot,
      leftoverSlot,
    ]);
    // 4 surplus, eating 6 → short by 2.
    expect(shortfallBySlot.get(leftoverSlot.id)).toBe(2);
    expect(remainingByBase.get(40)).toBe(-2);
  });

  it('pools a variation surplus under the variation, drawing the base by what was prepared', () => {
    const cookSlot = slot({ date: '2026-06-15', items: [cook(22, 12)] });
    // Prepare 6 variation portions (drawing 6 base), eat 4 → 2 variation left.
    const eatSlot = slot({
      date: '2026-06-16',
      items: [{ recipeId: 922, prepared: 6, eaten: 4, baseRecipeId: 22 }],
    });
    const leftoverSlot = slot({
      date: '2026-06-17',
      items: [eatLeftover(922, 2)],
    });
    const { shortfallBySlot, remainingByBase } = deriveBaseBalances([
      cookSlot,
      eatSlot,
      leftoverSlot,
    ]);
    expect(shortfallBySlot.size).toBe(0);
    expect(remainingByBase.get(22)).toBe(6); // 12 cooked − 6 into the variation
    expect(remainingByBase.get(922)).toBe(0); // 6 made − 4 eaten − 2 leftover
  });
});
