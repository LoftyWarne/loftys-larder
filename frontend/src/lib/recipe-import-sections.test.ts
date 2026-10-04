import { describe, expect, it } from 'vitest';

import { OLIVE_OIL, PROPOSAL } from '@/test/recipe-import-fixtures.ts';

import {
  originalLinesByRow,
  proposalToSections,
  readStoredSections,
} from './recipe-import-sections.ts';

const LOOKUP = new Map([[OLIVE_OIL.id, OLIVE_OIL]]);

describe('proposalToSections', () => {
  it('maps the header, with an existing source on the form and cost and image blank', () => {
    const sections = proposalToSections(
      { ...PROPOSAL, source: { id: 5 } },
      LOOKUP,
    );
    expect(sections.header).toMatchObject({
      name: 'Weeknight Pasta',
      baseServings: 2,
      caloriesPerServing: 410,
      sourceId: 5,
      estimatedCostPerServing: null,
      imageUrl: null,
      isBase: false,
      nutritionIsEstimated: true,
    });
    expect(sections.newSource).toBeNull();
  });

  it('holds a proposed new source by name', () => {
    const sections = proposalToSections(PROPOSAL, LOOKUP);
    expect(sections.header.sourceId).toBeNull();
    expect(sections.newSource).toBe('Pasta Weekly');
  });

  it('keeps the proposal’s row keys and points rows at matched or proposed ingredients', () => {
    const { ingredients } = proposalToSections(PROPOSAL, LOOKUP);
    expect(ingredients).toEqual([
      {
        key: 'i1',
        ingredient: OLIVE_OIL,
        quantity: '30',
        prepTypeId: null,
        isOptional: false,
      },
      {
        key: 'i2',
        ingredient: null,
        newKey: 'n1',
        quantity: '2',
        prepTypeId: null,
        isOptional: false,
      },
    ]);
  });

  it('leaves a row with no ingredient picked when its ingredient has gone', () => {
    const { ingredients } = proposalToSections(PROPOSAL, new Map());
    expect(ingredients[0]?.ingredient).toBeNull();
    expect(ingredients[0]?.newKey).toBeUndefined();
  });

  it('maps steps with their links, and stops them following the text', () => {
    const { method } = proposalToSections(PROPOSAL, LOOKUP);
    expect(method).toEqual([
      {
        key: 's1',
        instruction: 'Warm the oil and season with pepper.',
        safetyNote: null,
        tip: 'Don’t let the oil smoke.',
        prepAhead: null,
        ingredients: [
          { ingredientId: 7, quantity: '' },
          { newKey: 'n1', quantity: '1' },
        ],
        followsText: false,
      },
    ]);
  });

  it('carries tags, proposed ingredients and marks', () => {
    const sections = proposalToSections(PROPOSAL, LOOKUP);
    expect(sections.tags).toEqual(['Weeknight']);
    expect(sections.newIngredients).toEqual(PROPOSAL.newIngredients);
    expect(sections.estimates).toEqual(PROPOSAL.estimates);
  });

  it('holds original lines by row key', () => {
    expect(originalLinesByRow(PROPOSAL).get('i1')).toBe('2 tbsp olive oil');
  });
});

describe('readStoredSections', () => {
  const mapped = proposalToSections(PROPOSAL, LOOKUP);

  it('uses the mapped proposal when nothing has been saved', () => {
    expect(readStoredSections(mapped, { proposal: PROPOSAL })).toEqual(mapped);
  });

  it('lays saved sections over the mapped proposal', () => {
    const stored = readStoredSections(mapped, {
      header: { name: 'Pasta for two' },
      ingredients: [],
      tags: ['Quick'],
      newSource: null,
      estimates: [{ path: 'header.baseServings', kind: 'estimate' }],
      newIngredients: [
        {
          key: 'n1',
          name: 'Pepper',
          categoryId: null,
          defaultUnitId: 1,
          isPlant: false,
          averageShelfLifeDays: 30,
        },
      ],
    });
    expect(stored.header.name).toBe('Pasta for two');
    expect(stored.header.baseServings).toBe(2);
    expect(stored.ingredients).toEqual([]);
    expect(stored.method).toEqual(mapped.method);
    expect(stored.tags).toEqual(['Quick']);
    expect(stored.newSource).toBeNull();
    expect(stored.estimates).toEqual([
      { path: 'header.baseServings', kind: 'estimate' },
    ]);
    expect(stored.newIngredients[0]?.name).toBe('Pepper');
  });

  it('falls back to the proposal for a malformed section', () => {
    const stored = readStoredSections(mapped, {
      tags: 'Quick',
      newIngredients: [{ key: 'n1' }],
      estimates: [{ path: 'header.name', kind: 'guess' }],
    });
    expect(stored.tags).toEqual(mapped.tags);
    expect(stored.newIngredients).toEqual(mapped.newIngredients);
    expect(stored.estimates).toEqual(mapped.estimates);
  });
});
