import { describe, expect, it } from 'vitest';

import {
  type SuggestableIngredient,
  suggestStepIngredients,
} from './step-ingredient-suggestions.ts';

let nextId = 0;
function ingredient(
  name: string,
  unitName = 'g',
  total: number | null = 100,
): SuggestableIngredient {
  nextId += 1;
  return { ingredientId: nextId, name, unitName, total };
}

function suggest(
  text: string,
  ingredients: SuggestableIngredient[],
): [string, string | null][] {
  const byId = new Map(ingredients.map((i) => [i.ingredientId, i.name]));
  return suggestStepIngredients(text, ingredients).map((s) => [
    byId.get(s.ingredientId) ?? '?',
    s.quantity,
  ]);
}

describe('suggestStepIngredients', () => {
  describe('which ingredients', () => {
    it('matches whole names case-insensitively, with plurals, in order of mention', () => {
      expect(
        suggest('Warm the OLIVE OIL and add the onions.', [
          ingredient('Onion', 'piece'),
          ingredient('Olive Oil', 'tbsp'),
        ]),
      ).toEqual([
        ['Olive Oil', null],
        ['Onion', null],
      ]);
    });

    it('falls back to the last word of a name when no other ingredient uses it', () => {
      expect(
        suggest('Roast the potatoes, then mix the drained tuna with mayo.', [
          ingredient('Sweet Potato', 'piece'),
          ingredient('Tinned Tuna'),
          ingredient('Mayonnaise'),
        ]),
      ).toEqual([
        ['Sweet Potato', null],
        ['Tinned Tuna', null],
      ]);
    });

    it('skips the fallback when another ingredient shares the word', () => {
      expect(
        suggest('Add the chilli.', [
          ingredient('Red Chilli'),
          ingredient('Green Chilli'),
        ]),
      ).toEqual([]);
    });

    it('lets a longer name claim its text before a shorter one', () => {
      expect(
        suggest('Season with black pepper.', [
          ingredient('Pepper', 'piece'),
          ingredient('Black Pepper', 'pinch'),
        ]),
      ).toEqual([['Black Pepper', null]]);
    });

    it('ignores bracketed parts of a name and never matches inside a word', () => {
      expect(
        suggest('Pour in the tomatoes and the peanuts.', [
          ingredient('Tomatoes (tinned)'),
          ingredient('Pea'),
        ]),
      ).toEqual([['Tomatoes (tinned)', null]]);
    });
  });

  describe('amounts', () => {
    const butter = ingredient('Butter', 'g', 100);

    it.each([
      ['Melt 50 g butter.', '50'],
      ['Melt 50g of the butter.', '50'],
      ['Melt the butter (25 g).', '25'],
      ['Melt half the butter.', '50'],
      ['Melt half of the butter.', '50'],
      ['Melt the remaining butter.', null],
      ['Melt the butter.', null],
      ['Melt 2 tbsp butter.', null],
    ])('%s → %s', (text, expected) => {
      expect(suggest(text, [butter])).toEqual([['Butter', expected]]);
    });

    it('reads spoon amounts written as decimals, fractions or glyphs', () => {
      const cumin = ingredient('Cumin', 'tsp');
      expect(suggest('Add 1½ tsp cumin.', [cumin])).toEqual([['Cumin', '1.5']]);
      expect(suggest('Add ½ tsp cumin.', [cumin])).toEqual([['Cumin', '0.5']]);
      expect(suggest('Add 1/2 tsp of cumin.', [cumin])).toEqual([
        ['Cumin', '0.5'],
      ]);
      expect(suggest('Add 0.25 tsp cumin.', [cumin])).toEqual([
        ['Cumin', '0.25'],
      ]);
    });

    it('reads a bare count for a piece ingredient', () => {
      expect(
        suggest('Slice 2 onions.', [ingredient('Onion', 'piece')]),
      ).toEqual([['Onion', '2']]);
    });

    it('leaves ranges blank', () => {
      const oil = ingredient('Olive Oil', 'tbsp');
      expect(suggest('Add 2-3 tbsp olive oil.', [oil])).toEqual([
        ['Olive Oil', null],
      ]);
      expect(suggest('Add 2 to 3 tbsp olive oil.', [oil])).toEqual([
        ['Olive Oil', null],
      ]);
    });

    it('leaves "half" blank when the total is unknown', () => {
      expect(
        suggest('Melt half the butter.', [ingredient('Butter', 'g', null)]),
      ).toEqual([['Butter', null]]);
    });
  });
});
