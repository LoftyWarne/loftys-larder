import { createRecipeFromImportInputSchema } from '@loftys-larder/shared';
import { describe, expect, it } from 'vitest';

import { OLIVE_OIL, PROPOSAL } from '@/test/recipe-import-fixtures.ts';

import { buildCreateRecipeFromImportInput } from './recipe-import-create-input.ts';
import {
  proposalToSections,
  type ImportReviewSections,
} from './recipe-import-sections.ts';

function sections(
  patch: Partial<ImportReviewSections> = {},
): ImportReviewSections {
  return {
    ...proposalToSections(PROPOSAL, new Map([[OLIVE_OIL.id, OLIVE_OIL]])),
    ...patch,
  };
}

function oilRow(
  from: ImportReviewSections,
): ImportReviewSections['ingredients'][number] {
  const [row] = from.ingredients;
  if (!row) throw new Error('fixture has no rows');
  return row;
}

describe('buildCreateRecipeFromImportInput', () => {
  it('builds an input the server schema accepts', () => {
    const input = buildCreateRecipeFromImportInput(41, sections());
    expect(createRecipeFromImportInputSchema.safeParse(input).success).toBe(
      true,
    );
    expect(input.draftId).toBe(41);
  });

  it('sends existing rows with the unit the cook saw and proposed rows by key', () => {
    const input = buildCreateRecipeFromImportInput(41, sections());
    expect(input.lines).toEqual([
      {
        ingredient: { id: 7, unitId: 2 },
        quantity: '30',
        prepTypeId: null,
        isOptional: false,
      },
      {
        ingredient: { newKey: 'n1' },
        quantity: '2',
        prepTypeId: null,
        isOptional: false,
      },
    ]);
    expect(input.newIngredients).toEqual([
      {
        key: 'n1',
        name: 'Black pepper',
        categoryId: 3,
        defaultUnitId: 1,
        isPlant: true,
        averageShelfLifeDays: null,
      },
    ]);
  });

  it('builds from the sections, not the proposal', () => {
    const base = sections();
    const input = buildCreateRecipeFromImportInput(
      41,
      sections({
        header: { ...base.header, name: '  Pasta for two  ' },
        ingredients: [{ ...oilRow(base), quantity: '1/2' }],
        tags: [],
      }),
    );
    expect(input.header.name).toBe('  Pasta for two  ');
    expect(input.lines).toEqual([
      {
        ingredient: { id: 7, unitId: 2 },
        quantity: '0.5',
        prepTypeId: null,
        isOptional: false,
      },
    ]);
    expect(input.tagNames).toEqual([]);
  });

  it('leaves out proposed ingredients and step links no row uses', () => {
    const base = sections();
    const input = buildCreateRecipeFromImportInput(
      41,
      sections({ ingredients: [oilRow(base)] }),
    );
    expect(input.newIngredients).toEqual([]);
    expect(input.steps[0]?.ingredients).toEqual([
      { ingredient: { id: 7 }, quantity: null },
    ]);
  });

  it('sends step links by id or key, with blank amounts as not stated', () => {
    const input = buildCreateRecipeFromImportInput(41, sections());
    expect(input.steps).toEqual([
      {
        instruction: 'Warm the oil and season with pepper.',
        safetyNote: null,
        tip: 'Don’t let the oil smoke.',
        prepAhead: null,
        ingredients: [
          { ingredient: { id: 7 }, quantity: null },
          { ingredient: { newKey: 'n1' }, quantity: '1' },
        ],
      },
    ]);
  });

  it('sends a proposed source by name, or the existing source by id', () => {
    expect(buildCreateRecipeFromImportInput(41, sections()).source).toEqual({
      newName: 'Pasta Weekly',
    });
    const base = sections();
    expect(
      buildCreateRecipeFromImportInput(
        41,
        sections({ newSource: null, header: { ...base.header, sourceId: 5 } }),
      ).source,
    ).toEqual({ id: 5 });
    expect(
      buildCreateRecipeFromImportInput(41, sections({ newSource: null }))
        .source,
    ).toBeNull();
  });

  it('labels nutrition as estimated while a nutrition mark is left', () => {
    expect(
      buildCreateRecipeFromImportInput(41, sections()).header
        .nutritionIsEstimated,
    ).toBe(true);
    const base = sections();
    const withoutNutrition = buildCreateRecipeFromImportInput(
      41,
      sections({
        estimates: base.estimates.filter(
          (mark) => mark.path !== 'header.caloriesPerServing',
        ),
        // The form's own flag doesn't decide it.
        header: { ...base.header, nutritionIsEstimated: true },
      }),
    );
    expect(withoutNutrition.header.nutritionIsEstimated).toBe(false);
  });
});
