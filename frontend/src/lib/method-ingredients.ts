import type { RecipeImportProposedIngredient } from '@loftys-larder/shared';

import type { IngredientDraftLine } from '@/components/recipe-editor/ingredient-list.tsx';
import type { MethodIngredient } from '@/components/recipe-editor/method-editor.tsx';
import { parseQuantityToDecimal } from '@/lib/quantity-input.ts';

// Import Review: rows pointing at a proposed new ingredient take its name and
// unit from here.
export interface ProposedIngredientLookup {
  byKey: ReadonlyMap<string, RecipeImportProposedIngredient>;
  unitName: (unitId: number | null) => string;
}

// One entry per ingredient on the Ingredients section, unsaved edits
// included. A total pools the ingredient's lines and is `null` while any of
// them has no valid quantity. Draft lines are untyped JSON, so a malformed
// one is skipped.
export function toMethodIngredients(
  lines: readonly IngredientDraftLine[],
  proposed?: ProposedIngredientLookup,
): MethodIngredient[] {
  const byKey = new Map<number | string, MethodIngredient>();
  for (const line of lines) {
    const entry = toEntry(line, proposed);
    if (!entry) continue;
    const key = 'ingredientId' in entry ? entry.ingredientId : entry.newKey;
    const parsed =
      typeof line.quantity === 'string'
        ? parseQuantityToDecimal(line.quantity)
        : null;
    const existing = byKey.get(key);
    const priorTotal = existing ? existing.total : 0;
    byKey.set(key, {
      ...entry,
      total:
        priorTotal === null || parsed === null
          ? null
          : priorTotal + Number(parsed),
    });
  }
  return [...byKey.values()];
}

function toEntry(
  line: IngredientDraftLine,
  proposed: ProposedIngredientLookup | undefined,
): MethodIngredient | null {
  if (typeof line.newKey === 'string') {
    const ingredient = proposed?.byKey.get(line.newKey);
    if (!ingredient || !proposed) return null;
    return {
      newKey: line.newKey,
      name: ingredient.name.trim() || 'New ingredient',
      unitName: proposed.unitName(ingredient.defaultUnitId),
      total: null,
    };
  }
  const ingredient = line.ingredient as Partial<
    NonNullable<IngredientDraftLine['ingredient']>
  > | null;
  if (
    typeof ingredient?.id !== 'number' ||
    typeof ingredient.label !== 'string' ||
    typeof ingredient.unitName !== 'string'
  ) {
    return null;
  }
  return {
    ingredientId: ingredient.id,
    name: ingredient.label,
    unitName: ingredient.unitName,
    total: null,
  };
}
