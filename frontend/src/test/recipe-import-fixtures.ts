import type {
  GetRecipeImportResult,
  RecipeImportProposal,
} from '@loftys-larder/shared';

import type { IngredientPickerOption } from '@/components/recipe-editor/ingredient-list.tsx';

// A proposal shaped like the `fake` reader's: one matched ingredient with a
// converted quantity, one proposed new ingredient with a nominal quantity, a
// proposed new source, and an estimated serving count and calorie figure.
export const OLIVE_OIL: IngredientPickerOption = {
  id: 7,
  label: 'Olive oil',
  defaultUnitId: 2,
  unitName: 'ml',
};

export const PROPOSAL: RecipeImportProposal = {
  header: {
    name: 'Weeknight Pasta',
    description: null,
    baseServings: 2,
    activeTimeMins: 10,
    totalTimeMins: 20,
    estimatedCostPerServing: null,
    imageUrl: null,
    sourceUrl: null,
    sourceDetail: 'p. 42',
    caloriesPerServing: 410,
    proteinPerServing: null,
    carbsPerServing: null,
    fatPerServing: null,
    saturatedFatPerServing: null,
    fibrePerServing: null,
    sugarPerServing: null,
    saltPerServing: null,
  },
  source: { newName: 'Pasta Weekly' },
  newIngredients: [
    {
      key: 'n1',
      name: 'Black pepper',
      categoryId: 3,
      defaultUnitId: 1,
      isPlant: true,
      averageShelfLifeDays: null,
    },
  ],
  ingredients: [
    {
      key: 'i1',
      ingredient: { id: 7 },
      quantity: '30.000',
      prepTypeId: null,
      isOptional: false,
      originalLine: '2 tbsp olive oil',
    },
    {
      key: 'i2',
      ingredient: { newKey: 'n1' },
      quantity: '2',
      prepTypeId: null,
      isOptional: false,
      originalLine: 'Black pepper to taste',
    },
  ],
  method: [
    {
      key: 's1',
      instruction: 'Warm the oil and season with pepper.',
      safetyNote: null,
      tip: 'Don’t let the oil smoke.',
      prepAhead: null,
      ingredients: [
        { ingredient: { id: 7 }, quantity: null },
        { ingredient: { newKey: 'n1' }, quantity: '1.000' },
      ],
    },
  ],
  tags: ['Weeknight'],
  estimates: [
    { path: 'header.baseServings', kind: 'estimate' },
    { path: 'header.caloriesPerServing', kind: 'estimate' },
    { path: 'ingredient:i1.quantity', kind: 'converted' },
    { path: 'ingredient:i2.quantity', kind: 'nominal' },
    { path: 'step:s1.tip', kind: 'estimate' },
  ],
  notes: ['The method may continue on another page.'],
  reader: { adapter: 'fake', model: 'fake' },
  input: {
    kind: 'text',
    text: 'Weeknight Pasta\n2 tbsp olive oil\nBlack pepper to taste',
  },
};

export function importDraft(
  fields: Record<string, unknown> = {},
): GetRecipeImportResult {
  return {
    id: 41,
    proposal: PROPOSAL,
    images: [],
    draftData: { version: 1, fields: { proposal: PROPOSAL, ...fields } },
    lastUpdatedAt: 1_760_000_000_000,
  };
}
