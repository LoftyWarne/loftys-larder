import type { PlanSlot, PlanSlotItem } from '@loftys-larder/shared';
import { describe, expect, it } from 'vitest';

import { deriveBaseBalances } from './serving-variation-supply.ts';

let nextId = 1;

interface ItemSpec {
  recipeId: number;
  servings: number;
  kind: 'eat' | 'cook_ahead';
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
    servings: spec.servings,
    kind: spec.kind,
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
    slotType: items.some((i) => i.kind === 'eat') ? 'recipe' : 'empty',
    leftoversSource: null,
    chefUserId: null,
    comment: null,
    items: items.map(item),
    dinerUserIds: [],
    guestCount: 0,
  };
}

// Eat a serving variation of base B.
function eatVariation(baseId: number, servings: number): ItemSpec {
  return {
    recipeId: 900 + baseId,
    servings,
    kind: 'eat',
    baseRecipeId: baseId,
  };
}
// Eat the base B itself.
function eatBase(baseId: number, servings: number): ItemSpec {
  return { recipeId: baseId, servings, kind: 'eat', isBase: true };
}
function cook(baseId: number, servings: number): ItemSpec {
  return { recipeId: baseId, servings, kind: 'cook_ahead', isBase: true };
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
});
