import type { RecipeImportEstimate } from '@loftys-larder/shared';
import { describe, expect, it } from 'vitest';

import {
  ESTIMATE_LABELS,
  changedHeaderPaths,
  changedQuantityPaths,
  changedStepPaths,
  clearEstimates,
  hasNutritionEstimate,
  indexEstimates,
  withNutritionEstimates,
  withoutNutritionEstimates,
} from './recipe-import-estimates.ts';

const MARKS: RecipeImportEstimate[] = [
  { path: 'header.baseServings', kind: 'estimate' },
  { path: 'header.caloriesPerServing', kind: 'estimate' },
  { path: 'ingredient:i1.quantity', kind: 'converted' },
  { path: 'ingredient:i2.quantity', kind: 'nominal' },
  { path: 'step:s1.tip', kind: 'estimate' },
];

describe('Estimate marks', () => {
  it('words converted and nominal quantities differently', () => {
    expect(ESTIMATE_LABELS.estimate).toBe('Estimated');
    expect(ESTIMATE_LABELS.converted).toBe('Converted — check the amount');
    expect(ESTIMATE_LABELS.nominal).toBe(
      'Not in the original — amount guessed',
    );
  });

  it('indexes marks by path', () => {
    const index = indexEstimates(MARKS);
    expect(index.get('ingredient:i1.quantity')).toBe('converted');
    expect(index.get('header.name')).toBeUndefined();
  });

  it('clears the mark of a header field that changed, and only that one', () => {
    const paths = changedHeaderPaths(
      { baseServings: 2, caloriesPerServing: 410, name: 'Soup' },
      { baseServings: 4, caloriesPerServing: 410, name: 'Soup' },
    );
    expect([...paths]).toEqual(['header.baseServings']);
    expect(clearEstimates(MARKS, paths).map((mark) => mark.path)).toEqual([
      'header.caloriesPerServing',
      'ingredient:i1.quantity',
      'ingredient:i2.quantity',
      'step:s1.tip',
    ]);
  });

  it('keeps a cleared mark cleared when the value goes back', () => {
    const afterEdit = clearEstimates(
      MARKS,
      changedHeaderPaths({ baseServings: 2 }, { baseServings: 4 }),
    );
    const afterRevert = clearEstimates(
      afterEdit,
      changedHeaderPaths({ baseServings: 4 }, { baseServings: 2 }),
    );
    expect(indexEstimates(afterRevert).has('header.baseServings')).toBe(false);
  });

  it('returns the same marks when nothing changed', () => {
    const paths = changedHeaderPaths({ name: 'Soup' }, { name: 'Soup' });
    expect(clearEstimates(MARKS, paths)).toBe(MARKS);
  });

  it('clears a quantity mark when the row quantity changes or the row goes', () => {
    const before = [
      { key: 'i1', quantity: '30' },
      { key: 'i2', quantity: '2' },
      { quantity: '5' },
    ];
    expect([
      ...changedQuantityPaths(before, [{ key: 'i1', quantity: '45' }]),
    ]).toEqual(['ingredient:i1.quantity', 'ingredient:i2.quantity']);
    expect(changedQuantityPaths(before, before).size).toBe(0);
  });

  it('clears a step mark when that field of the step changes', () => {
    const before = [
      {
        key: 's1',
        tip: 'Rest it',
        safetyNote: null,
        prepAhead: null,
        ingredients: [{ ingredientId: 1, quantity: '' }],
      },
    ];
    expect([
      ...changedStepPaths(before, [{ ...before[0], tip: 'Rest it well' }]),
    ]).toEqual(['step:s1.tip']);
    expect([
      ...changedStepPaths(before, [
        { ...before[0], ingredients: [{ ingredientId: 1, quantity: '5' }] },
      ]),
    ]).toEqual(['step:s1.ingredients']);
    expect(changedStepPaths(before, []).size).toBe(4);
  });

  it('finds, removes and adds nutrition marks', () => {
    expect(hasNutritionEstimate(MARKS)).toBe(true);
    const without = withoutNutritionEstimates(MARKS);
    expect(hasNutritionEstimate(without)).toBe(false);
    expect(without).toHaveLength(MARKS.length - 1);

    const readded = withNutritionEstimates(without, {
      caloriesPerServing: 410,
      fatPerServing: null,
      proteinPerServing: 12,
    });
    expect(
      readded
        .filter((mark) => mark.path.startsWith('header.'))
        .map((mark) => mark.path),
    ).toEqual([
      'header.baseServings',
      'header.caloriesPerServing',
      'header.proteinPerServing',
    ]);
  });

  it('adds nothing when there are no nutrition values to mark', () => {
    const without = withoutNutritionEstimates(MARKS);
    expect(withNutritionEstimates(without, {})).toBe(without);
  });
});
