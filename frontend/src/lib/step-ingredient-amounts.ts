import type {
  RecipeIngredientLine,
  RecipeMethodStep,
} from '@loftys-larder/shared';

export interface StepIngredientChip {
  ingredientId: number;
  name: string;
  unitName: string;
  // Unscaled. `null` means the chip shows the name alone.
  amount: number | null;
  isOptional: boolean;
}

interface IngredientTotal {
  name: string;
  unitName: string;
  totalMilli: number;
  allOptional: boolean;
  order: number;
}

// What each method step's ingredient chips show (DEC-99), keyed by step id. A
// stated amount shows as entered. A blank amount gets what's left of the
// recipe total when it's the only blank step for that ingredient; otherwise
// the chip shows just the name. Links to an ingredient the recipe no longer
// lists are dropped. Repeated lines of one ingredient (DEC-20) pool into a
// single total. Chips follow ingredient-list order.
export function stepIngredientChips(
  lines: readonly RecipeIngredientLine[],
  method: readonly RecipeMethodStep[],
): Map<number, StepIngredientChip[]> {
  const totals = new Map<number, IngredientTotal>();
  lines.forEach((line, index) => {
    const existing = totals.get(line.ingredientId);
    totals.set(line.ingredientId, {
      name: line.ingredientName,
      unitName: line.unitName,
      totalMilli: (existing?.totalMilli ?? 0) + toMilli(line.quantity),
      allOptional: (existing?.allOptional ?? true) && line.isOptional,
      order: existing?.order ?? index,
    });
  });

  const statedMilli = new Map<number, number>();
  const blankCount = new Map<number, number>();
  for (const step of method) {
    for (const link of step.ingredients) {
      if (link.quantity === null) {
        blankCount.set(
          link.ingredientId,
          (blankCount.get(link.ingredientId) ?? 0) + 1,
        );
      } else {
        statedMilli.set(
          link.ingredientId,
          (statedMilli.get(link.ingredientId) ?? 0) + toMilli(link.quantity),
        );
      }
    }
  }

  const chipsByStep = new Map<number, StepIngredientChip[]>();
  for (const step of method) {
    const chips = step.ingredients.flatMap((link) => {
      const total = totals.get(link.ingredientId);
      if (!total) return [];
      let amount: number | null = null;
      if (link.quantity !== null) {
        amount = Number(link.quantity);
      } else if (blankCount.get(link.ingredientId) === 1) {
        const leftMilli =
          total.totalMilli - (statedMilli.get(link.ingredientId) ?? 0);
        if (leftMilli > 0) amount = leftMilli / 1000;
      }
      const chip: StepIngredientChip = {
        ingredientId: link.ingredientId,
        name: total.name,
        unitName: total.unitName,
        amount,
        isOptional: total.allOptional,
      };
      return [{ chip, order: total.order }];
    });
    chipsByStep.set(
      step.id,
      chips.sort((a, b) => a.order - b.order).map(({ chip }) => chip),
    );
  }
  return chipsByStep;
}

// Sums in integer thousandths so float error can't leave a stray 0.001.
function toMilli(quantity: string): number {
  return Math.round(Number(quantity) * 1000);
}
