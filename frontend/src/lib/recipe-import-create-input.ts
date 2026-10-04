import type {
  CreateRecipeFromImportInput,
  RecipeImportIngredientRef,
} from '@loftys-larder/shared';

import type { HeaderFormValues } from '@/components/recipe-editor/header-fields.tsx';
import { parseQuantityToDecimal } from '@/lib/quantity-input.ts';
import { hasNutritionEstimate } from '@/lib/recipe-import-estimates.ts';
import type { ImportReviewSections } from '@/lib/recipe-import-sections.ts';

type Line = CreateRecipeFromImportInput['lines'][number];

// The create-from-import input, built from the editor's sections and never
// from the stored proposal (DEC-108). Call it once every section has passed
// its own validation; a value that validation should have caught throws.
export function buildCreateRecipeFromImportInput(
  draftId: number,
  sections: ImportReviewSections,
): CreateRecipeFromImportInput {
  const lines = sections.ingredients.map((line): Line => {
    const quantity = parseQuantityToDecimal(line.quantity);
    if (quantity === null) throw new Error('quantity invalid after validation');
    return {
      ingredient: lineIngredient(line),
      quantity,
      prepTypeId: line.prepTypeId,
      isOptional: line.isOptional ?? false,
    };
  });

  const onLines = new Set(lines.map((line) => refKey(line.ingredient)));
  const usedNewKeys = new Set(
    lines.flatMap((line) =>
      'newKey' in line.ingredient ? [line.ingredient.newKey] : [],
    ),
  );

  return {
    draftId,
    header: toHeader(sections),
    source:
      sections.newSource !== null
        ? { newName: sections.newSource.trim() }
        : typeof sections.header.sourceId === 'number'
          ? { id: sections.header.sourceId }
          : null,
    newIngredients: sections.newIngredients
      .filter((ingredient) => usedNewKeys.has(ingredient.key))
      .map((ingredient) => {
        if (
          ingredient.categoryId === null ||
          ingredient.defaultUnitId === null
        ) {
          throw new Error('new ingredient incomplete after validation');
        }
        return {
          key: ingredient.key,
          name: ingredient.name.trim(),
          categoryId: ingredient.categoryId,
          defaultUnitId: ingredient.defaultUnitId,
          isPlant: ingredient.isPlant,
          averageShelfLifeDays: ingredient.averageShelfLifeDays,
        };
      }),
    lines,
    steps: sections.method.map((step) => {
      const seen = new Set<string>();
      return {
        instruction: step.instruction.trim(),
        safetyNote: toNote(step.safetyNote),
        tip: toNote(step.tip),
        prepAhead: step.prepAhead ?? null,
        // Links to an ingredient no longer on the Ingredients section are
        // left out, as the editor does on save.
        ingredients: (step.ingredients ?? []).flatMap((link) => {
          const ingredient: RecipeImportIngredientRef =
            'ingredientId' in link
              ? { id: link.ingredientId }
              : { newKey: link.newKey };
          const key = refKey(ingredient);
          if (!onLines.has(key) || seen.has(key)) return [];
          seen.add(key);
          return [
            {
              ingredient,
              quantity:
                link.quantity.trim() === ''
                  ? null
                  : parseQuantityToDecimal(link.quantity),
            },
          ];
        }),
      };
    }),
    tagNames: [...sections.tags],
  };
}

function lineIngredient(
  line: ImportReviewSections['ingredients'][number],
): Line['ingredient'] {
  if (line.newKey !== undefined) return { newKey: line.newKey };
  if (!line.ingredient) throw new Error('ingredient missing after validation');
  return { id: line.ingredient.id, unitId: line.ingredient.defaultUnitId };
}

function refKey(ref: { id: number } | { newKey: string }): string {
  return 'id' in ref ? `id:${String(ref.id)}` : `new:${ref.newKey}`;
}

function toNote(note: string | null | undefined): string | null {
  const trimmed = note?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

// Every header field the create input carries. The form leaves optional
// fields undefined until touched; the input wants them null.
function toHeader(
  sections: ImportReviewSections,
): CreateRecipeFromImportInput['header'] {
  const header: HeaderFormValues = sections.header;
  return {
    name: header.name,
    description: header.description ?? null,
    imageUrl: header.imageUrl ?? null,
    baseServings: header.baseServings,
    activeTimeMins: header.activeTimeMins ?? null,
    totalTimeMins: header.totalTimeMins ?? null,
    estimatedCostPerServing: header.estimatedCostPerServing ?? null,
    sourceUrl: header.sourceUrl ?? null,
    sourceDetail: header.sourceDetail ?? null,
    caloriesPerServing: header.caloriesPerServing ?? null,
    proteinPerServing: header.proteinPerServing ?? null,
    carbsPerServing: header.carbsPerServing ?? null,
    fatPerServing: header.fatPerServing ?? null,
    saturatedFatPerServing: header.saturatedFatPerServing ?? null,
    fibrePerServing: header.fibrePerServing ?? null,
    sugarPerServing: header.sugarPerServing ?? null,
    saltPerServing: header.saltPerServing ?? null,
    // Any nutrition Estimate still marked keeps the label (DEC-106).
    nutritionIsEstimated: hasNutritionEstimate(sections.estimates),
  };
}
