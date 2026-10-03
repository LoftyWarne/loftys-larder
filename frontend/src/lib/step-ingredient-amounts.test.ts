import type {
  RecipeIngredientLine,
  RecipeMethodStep,
} from '@loftys-larder/shared';
import { describe, expect, it } from 'vitest';

import { stepIngredientChips } from './step-ingredient-amounts.ts';

function line(
  ingredientId: number,
  ingredientName: string,
  quantity: string,
  overrides: Partial<RecipeIngredientLine> = {},
): RecipeIngredientLine {
  return {
    id: ingredientId * 10,
    ingredientId,
    ingredientName,
    quantity,
    unitId: 1,
    unitName: 'g',
    prepTypeId: null,
    prepTypeName: null,
    isPlant: false,
    isOptional: false,
    ...overrides,
  };
}

function step(
  id: number,
  ingredients: RecipeMethodStep['ingredients'],
): RecipeMethodStep {
  return {
    id,
    stepNumber: id,
    instruction: `Step ${String(id)}`,
    safetyNote: null,
    tip: null,
    prepAhead: null,
    ingredients,
  };
}

const BUTTER = 1;
const CARROT = 2;

function amounts(
  lines: RecipeIngredientLine[],
  method: RecipeMethodStep[],
): (number | null)[][] {
  const chips = stepIngredientChips(lines, method);
  return method.map((s) => (chips.get(s.id) ?? []).map((c) => c.amount));
}

describe('stepIngredientChips', () => {
  const lines = [line(BUTTER, 'Butter', '100.000')];

  it('gives a lone blank step the whole total', () => {
    expect(
      amounts(lines, [step(1, [{ ingredientId: BUTTER, quantity: null }])]),
    ).toEqual([[100]]);
  });

  it('gives the only blank step what is left after stated amounts', () => {
    expect(
      amounts(lines, [
        step(1, [{ ingredientId: BUTTER, quantity: '33.333' }]),
        step(2, [{ ingredientId: BUTTER, quantity: null }]),
      ]),
    ).toEqual([[33.333], [66.667]]);
  });

  it('shows just the name when more than one step leaves the amount blank', () => {
    expect(
      amounts(lines, [
        step(1, [{ ingredientId: BUTTER, quantity: '50' }]),
        step(2, [{ ingredientId: BUTTER, quantity: null }]),
        step(3, [{ ingredientId: BUTTER, quantity: null }]),
      ]),
    ).toEqual([[50], [null], [null]]);
  });

  it('shows just the name when nothing is left for the blank step', () => {
    expect(
      amounts(lines, [
        step(1, [{ ingredientId: BUTTER, quantity: '100' }]),
        step(2, [{ ingredientId: BUTTER, quantity: null }]),
      ]),
    ).toEqual([[100], [null]]);
  });

  it('pools repeated lines of one ingredient into a single total', () => {
    expect(
      amounts(
        [line(BUTTER, 'Butter', '60'), line(BUTTER, 'Butter', '40')],
        [step(1, [{ ingredientId: BUTTER, quantity: null }])],
      ),
    ).toEqual([[100]]);
  });

  it('drops links to an ingredient the recipe no longer lists', () => {
    expect(
      amounts(lines, [step(1, [{ ingredientId: 99, quantity: '5' }])]),
    ).toEqual([[]]);
  });

  it('orders chips by the ingredient list and carries name, unit and optional', () => {
    const chips = stepIngredientChips(
      [
        line(CARROT, 'Carrot', '3', { unitName: 'piece', isOptional: true }),
        line(BUTTER, 'Butter', '100'),
      ],
      [
        step(1, [
          { ingredientId: BUTTER, quantity: '20' },
          { ingredientId: CARROT, quantity: null },
        ]),
      ],
    );
    expect(chips.get(1)).toEqual([
      {
        ingredientId: CARROT,
        name: 'Carrot',
        unitName: 'piece',
        amount: 3,
        isOptional: true,
      },
      {
        ingredientId: BUTTER,
        name: 'Butter',
        unitName: 'g',
        amount: 20,
        isOptional: false,
      },
    ]);
  });

  it('marks an ingredient optional only when every line of it is optional', () => {
    const chips = stepIngredientChips(
      [
        line(BUTTER, 'Butter', '60', { isOptional: true }),
        line(BUTTER, 'Butter', '40'),
      ],
      [step(1, [{ ingredientId: BUTTER, quantity: null }])],
    );
    expect(chips.get(1)?.[0]?.isOptional).toBe(false);
  });
});
