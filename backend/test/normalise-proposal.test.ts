import { describe, expect, it } from 'vitest';

import type { RecipeImportCandidate } from '../../shared/src/index.ts';
import { normaliseProposal } from '../src/lib/recipe-import/normalise-proposal.ts';
import type { RecipeReaderHousehold } from '../src/lib/recipe-reader/types.ts';

const household: RecipeReaderHousehold = {
  ingredients: [
    { id: 10, name: 'Olive Oil', unitId: 2, unitName: 'ml' },
    { id: 11, name: 'Onion', unitId: 1, unitName: 'g' },
  ],
  categories: [{ id: 5, name: 'Fruit & Veg' }],
  units: [
    { id: 1, name: 'g' },
    { id: 2, name: 'ml' },
  ],
  prepTypes: [{ id: 7, name: 'chopped' }],
  tags: [{ id: 3, name: 'Vegetarian' }],
  sources: [{ id: 4, name: 'BBC Good Food' }],
};

function candidate(
  overrides: Partial<RecipeImportCandidate> = {},
): RecipeImportCandidate {
  return {
    header: {
      name: 'Tomato Soup',
      description: 'A quick soup.',
      baseServings: 4,
      activeTimeMins: 10,
      totalTimeMins: 30,
      caloriesPerServing: 210,
      proteinPerServing: 5.5,
      carbsPerServing: null,
      fatPerServing: null,
      saturatedFatPerServing: null,
      fibrePerServing: null,
      sugarPerServing: null,
      saltPerServing: 1.2,
      sourceUrl: null,
      sourceDetail: null,
    },
    source: null,
    newIngredients: [
      {
        key: 'n1',
        name: 'Basil',
        categoryId: 5,
        defaultUnitId: 1,
        isPlant: true,
        averageShelfLifeDays: 5,
      },
    ],
    ingredients: [
      {
        key: 'i1',
        ingredient: { id: 10, name: 'Olive Oil' },
        quantity: 30,
        prepTypeId: null,
        isOptional: false,
        originalLine: '2 tbsp olive oil',
      },
      {
        key: 'i2',
        ingredient: { id: 11, name: 'Onion' },
        quantity: 150,
        prepTypeId: 7,
        isOptional: false,
        originalLine: '1 onion, chopped',
      },
      {
        key: 'i3',
        ingredient: { newKey: 'n1' },
        quantity: 5,
        prepTypeId: null,
        isOptional: true,
        originalLine: 'A handful of basil (optional)',
      },
    ],
    method: [
      {
        key: 's1',
        instruction: 'Fry the onion in the oil.',
        safetyNote: null,
        tip: null,
        prepAhead: null,
        ingredients: [
          { ingredient: { id: 10, name: 'Olive Oil' }, quantity: null },
          { ingredient: { id: 11, name: 'Onion' }, quantity: 150 },
        ],
      },
    ],
    tags: ['vegetarian'],
    estimates: [
      { path: 'header.caloriesPerServing', kind: 'estimate' },
      { path: 'ingredient:i2.quantity', kind: 'converted' },
      { path: 'step:s1.ingredients', kind: 'estimate' },
    ],
    notes: [],
    ...overrides,
  };
}

function normalised(value: unknown) {
  const result = normaliseProposal(value, household);
  if (!result.ok) {
    throw new Error(`expected a proposal, got ${result.issues.join(', ')}`);
  }
  return result.proposal;
}

describe('normaliseProposal', () => {
  it('turns a valid candidate into a proposal in the write formats', () => {
    const proposal = normalised(candidate());
    expect(proposal.header).toMatchObject({
      name: 'Tomato Soup',
      baseServings: 4,
      caloriesPerServing: 210,
      proteinPerServing: 5.5,
      estimatedCostPerServing: null,
      imageUrl: null,
    });
    expect(proposal.ingredients.map((row) => row.quantity)).toEqual([
      '30',
      '150',
      '5',
    ]);
    expect(proposal.ingredients[1]).toMatchObject({
      ingredient: { id: 11 },
      prepTypeId: 7,
      originalLine: '1 onion, chopped',
    });
    expect(proposal.method[0]?.ingredients).toEqual([
      { ingredient: { id: 10 }, quantity: null },
      { ingredient: { id: 11 }, quantity: '150' },
    ]);
  });

  it.each([
    ['not an object', 'a recipe'],
    ['no header', { ...candidate(), header: undefined }],
    ['a missing field', { ...candidate(), notes: undefined }],
  ])('fails on %s', (_label, value) => {
    expect(normaliseProposal(value, household).ok).toBe(false);
  });

  it('fails when a value breaks the proposal schema, and reports its path', () => {
    const value = candidate();
    const row = value.ingredients[0];
    if (!row) throw new Error('fixture');
    row.quantity = -1;
    const result = normaliseProposal(value, household);
    expect(result).toEqual({ ok: false, issues: ['ingredients.0.quantity'] });
  });

  it('fails on a reference to a new ingredient that was never proposed', () => {
    const value = candidate();
    const row = value.ingredients[2];
    if (!row) throw new Error('fixture');
    row.ingredient = { newKey: 'n9' };
    expect(normaliseProposal(value, household).ok).toBe(false);
  });

  it('fails on duplicate row keys', () => {
    const value = candidate();
    const row = value.ingredients[1];
    if (!row) throw new Error('fixture');
    row.key = 'i1';
    expect(normaliseProposal(value, household).ok).toBe(false);
  });

  it('strips markdown from every text field', () => {
    const value = candidate({
      notes: ['**Check** the oven temperature'],
    });
    value.header.name = '## Tomato Soup';
    value.header.description = 'A *quick* soup.';
    value.header.sourceDetail = '[Page 12](https://example.com)';
    const step = value.method[0];
    const row = value.ingredients[0];
    if (!step || !row) throw new Error('fixture');
    step.instruction = '- Fry the **onion**.';
    step.tip = '_Low_ heat.';
    row.originalLine = '* 2 tbsp olive oil';

    const proposal = normalised(value);
    expect(proposal.header.name).toBe('Tomato Soup');
    expect(proposal.header.description).toBe('A quick soup.');
    expect(proposal.header.sourceDetail).toBe('Page 12');
    expect(proposal.method[0]?.instruction).toBe('Fry the onion.');
    expect(proposal.method[0]?.tip).toBe('Low heat.');
    expect(proposal.ingredients[0]?.originalLine).toBe('2 tbsp olive oil');
    expect(proposal.notes).toEqual(['Check the oven temperature']);
  });

  it('turns an unknown ingredient into one proposed new ingredient, shared by rows and steps', () => {
    const value = candidate();
    const row = value.ingredients[0];
    const step = value.method[0];
    if (!row || !step) throw new Error('fixture');
    row.ingredient = { id: 999, name: 'Rapeseed Oil' };
    step.ingredients[0] = {
      ingredient: { id: 999, name: 'Rapeseed Oil' },
      quantity: null,
    };

    const proposal = normalised(value);
    const added = proposal.newIngredients.find(
      (ingredient) => ingredient.name === 'Rapeseed Oil',
    );
    expect(added).toMatchObject({
      categoryId: null,
      defaultUnitId: null,
      isPlant: false,
      averageShelfLifeDays: null,
    });
    expect(proposal.ingredients[0]?.ingredient).toEqual({
      newKey: added?.key,
    });
    expect(proposal.method[0]?.ingredients[0]?.ingredient).toEqual({
      newKey: added?.key,
    });
  });

  it('points an unknown id at a proposed ingredient of the same name', () => {
    const value = candidate();
    const row = value.ingredients[0];
    if (!row) throw new Error('fixture');
    row.ingredient = { id: 999, name: 'basil' };
    const proposal = normalised(value);
    expect(proposal.newIngredients).toHaveLength(1);
    expect(proposal.ingredients[0]?.ingredient).toEqual({ newKey: 'n1' });
  });

  it('drops a category, unit or prep type the household does not have', () => {
    const value = candidate();
    const added = value.newIngredients[0];
    const row = value.ingredients[1];
    if (!added || !row) throw new Error('fixture');
    added.categoryId = 404;
    added.defaultUnitId = 404;
    row.prepTypeId = 404;
    const proposal = normalised(value);
    expect(proposal.newIngredients[0]).toMatchObject({
      categoryId: null,
      defaultUnitId: null,
    });
    expect(proposal.ingredients[1]?.prepTypeId).toBeNull();
  });

  it('keeps only household tags, in their household spelling', () => {
    const proposal = normalised(
      candidate({ tags: ['VEGETARIAN', 'Vegan', 'vegetarian'] }),
    );
    expect(proposal.tags).toEqual(['Vegetarian']);
  });

  it.each([
    ['an unknown source id', { id: 404 }, null],
    ['a known source id', { id: 4 }, { id: 4 }],
    ['a new name matching a source', { newName: 'bbc good food' }, { id: 4 }],
    [
      'a new name',
      { newName: 'Ottolenghi Simple' },
      { newName: 'Ottolenghi Simple' },
    ],
  ] as const)('resolves %s', (_label, source, expected) => {
    const proposal = normalised(candidate({ source }));
    expect(proposal.source).toEqual(expected);
  });

  it('keeps Estimate marks as given, dropping ones that point at nothing', () => {
    const proposal = normalised(
      candidate({
        estimates: [
          { path: 'header.caloriesPerServing', kind: 'estimate' },
          { path: 'ingredient:i2.quantity', kind: 'converted' },
          { path: 'ingredient:i3.quantity', kind: 'nominal' },
          { path: 'ingredient:i9.quantity', kind: 'nominal' },
          { path: 'step:s1.tip', kind: 'estimate' },
          { path: 'step:s1.colour', kind: 'estimate' },
          { path: 'header.notAField', kind: 'estimate' },
          { path: 'somewhere else', kind: 'estimate' },
          { path: 'header.caloriesPerServing', kind: 'estimate' },
        ],
      }),
    );
    expect(proposal.estimates).toEqual([
      { path: 'header.caloriesPerServing', kind: 'estimate' },
      { path: 'ingredient:i2.quantity', kind: 'converted' },
      { path: 'ingredient:i3.quantity', kind: 'nominal' },
      { path: 'step:s1.tip', kind: 'estimate' },
    ]);
  });

  it('rounds numbers to what the columns hold', () => {
    const value = candidate();
    value.header.baseServings = 3.6;
    value.header.caloriesPerServing = 409.6;
    value.header.saltPerServing = 1.237;
    const row = value.ingredients[0];
    if (!row) throw new Error('fixture');
    row.quantity = 29.57353;
    const proposal = normalised(value);
    expect(proposal.header).toMatchObject({
      baseServings: 4,
      caloriesPerServing: 410,
      saltPerServing: 1.24,
    });
    expect(proposal.ingredients[0]?.quantity).toBe('29.574');
  });

  it('blanks a zero step amount and drops a repeated step link', () => {
    const value = candidate();
    const step = value.method[0];
    if (!step) throw new Error('fixture');
    step.ingredients = [
      { ingredient: { id: 11, name: 'Onion' }, quantity: 0 },
      { ingredient: { id: 11, name: 'Onion' }, quantity: 50 },
    ];
    const proposal = normalised(value);
    expect(proposal.method[0]?.ingredients).toEqual([
      { ingredient: { id: 11 }, quantity: null },
    ]);
  });

  it('keeps at most five notes', () => {
    const proposal = normalised(
      candidate({ notes: ['a', 'b', 'c', 'd', 'e', 'f', ' '] }),
    );
    expect(proposal.notes).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});
